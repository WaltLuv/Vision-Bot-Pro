import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import {z} from 'zod';
import {Store} from '../src/employee/db.js';import {ToolGateway} from '../src/employee/tools.js';
import {BUILTIN_SUPPLIERS,CatalogAdapter,compareOffers,configuredSuppliers,isSecureEndpoint,loadSuppliers,offerSchema,scoreMatch,searchSuppliers,supplierConfigSchema,type Offer,type SupplierAdapter} from '../src/employee/suppliers.js';
import {EbayBrowse,optionalSuppliers,registerProcurement,registerSupplier,type SupplierCheckout} from '../src/employee/procurement.js';

const builtin=(id:string,endpoint='https://partner.example.test/search?q={query}')=>supplierConfigSchema.parse({
 id,name:BUILTIN_SUPPLIERS[id]!.name,method:BUILTIN_SUPPLIERS[id]!.method,endpoint,
 auth:{type:BUILTIN_SUPPLIERS[id]!.authType,env:BUILTIN_SUPPLIERS[id]!.authEnv,header:BUILTIN_SUPPLIERS[id]!.authHeader},
 mapping:{items:'items',sku:'id',product:'name',url:'url',unitPrice:'price',...BUILTIN_SUPPLIERS[id]!.mapping},
});
const adapterFor=(id:string,payload:unknown)=>new CatalogAdapter(builtin(id),(async()=>new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}})) as unknown as typeof fetch);

function stub(id:string,name:string,offers:Partial<Offer>[],behaviour:'ok'|'throw'|'hang'='ok'):SupplierAdapter&{calls:number}{
 return {id,name,method:'official_api',requires:[],calls:0,configured(){return true;},
  async search(query,quantity,currency){(this as any).calls++;
   if(behaviour==='throw')throw Error('provider exploded');
   if(behaviour==='hang')await new Promise(r=>setTimeout(r,5000));
   return offers.map(o=>offerSchema.parse({supplierId:id,supplier:name,method:'official_api',sku:'sku-'+id,product:query,url:`https://${id}.example.test/p`,quantity,unitPrice:10,currency,observedAt:new Date().toISOString(),...o}));
  }} as SupplierAdapter&{calls:number};
}

// --- parallel search ------------------------------------------------------

test('every connected supplier is searched, not just the first that answers',async()=>{
 const a=stub('home_depot','The Home Depot',[{}]),b=stub('lowes',"Lowe's",[{}]),c=stub('amazon','Amazon',[{}]),d=stub('walmart','Walmart',[{}]);
 const {offers,suppliers}=await searchSuppliers([a,b,c,d],'m6 bolt',2,'USD');
 for(const s of [a,b,c,d])assert.equal((s as any).calls,1,`${s.id} was searched`);
 assert.equal(offers.length,4);
 assert.deepEqual(suppliers.map(s=>s.id).sort(),['amazon','home_depot','lowes','walmart']);
 assert.ok(suppliers.every(s=>s.status==='ok'&&s.checkedAt));
});

// A supplier being down is the normal case, not an outage of the whole feature.
test('one supplier failing does not erase the offers the others returned',async()=>{
 const good=stub('home_depot','The Home Depot',[{unitPrice:5}]),bad=stub('lowes',"Lowe's",[],'throw'),also=stub('walmart','Walmart',[{unitPrice:7}]);
 const {offers,suppliers}=await searchSuppliers([good,bad,also],'bolt',1,'USD');
 assert.equal(offers.length,2,'successful suppliers still produced offers');
 const failed=suppliers.find(s=>s.id==='lowes')!;
 assert.equal(failed.status,'failed');
 assert.equal(failed.offers,0);
 assert.ok(failed.detail,'the failure is reported to the person');
 assert.ok(!/exploded/.test(failed.detail!),'the raw provider error is not leaked');
 assert.equal(suppliers.filter(s=>s.status==='ok').length,2);
});

test('a supplier that does not answer in time is reported, not waited on forever',async()=>{
 const before=process.env.SUPPLIER_TIMEOUT_MS;process.env.SUPPLIER_TIMEOUT_MS='150';
 try{
  const slow=stub('amazon','Amazon',[],'hang'),quick=stub('walmart','Walmart',[{}]);
  const started=Date.now();
  const {offers,suppliers}=await searchSuppliers([slow,quick],'bolt',1,'USD');
  assert.ok(Date.now()-started<3000,'the search did not wait for the slow supplier');
  assert.equal(offers.length,1);
  assert.equal(suppliers.find(s=>s.id==='amazon')!.status,'timeout');
 }finally{if(before===undefined)delete process.env.SUPPLIER_TIMEOUT_MS;else process.env.SUPPLIER_TIMEOUT_MS=before;}
});

test('a supplier missing its credential is reported as unconfigured with what it needs',async()=>{
 const missing:SupplierAdapter={id:'home_depot',name:'The Home Depot',method:'partner_api',requires:['HOME_DEPOT_API_KEY'],configured:()=>false,search:async()=>{throw Error('should not be called');}};
 const {suppliers}=await searchSuppliers([missing],'bolt',1,'USD');
 assert.equal(suppliers[0]!.status,'unconfigured');
 assert.match(suppliers[0]!.detail!,/HOME_DEPOT_API_KEY/);
});

// --- one comparison model -------------------------------------------------

test('offers from different suppliers compare in one model, exact matches first',async()=>{
 const now=new Date().toISOString();
 const make=(supplierId:string,unitPrice:number,shipping:number|null,product:string)=>offerSchema.parse({supplierId,supplier:supplierId,method:'official_api',sku:'s',product,url:'https://x.example.test/p',quantity:1,unitPrice,currency:'USD',shipping,tax:0,fees:0,observedAt:now,matchQuality:product==='m6 bolt'?'exact':'candidate'});
 const ranked=compareOffers([make('walmart',9,2,'m6 bolt washer'),make('home_depot',10,1,'m6 bolt'),make('lowes',3,null,'m6 bolt')],'USD');
 assert.deepEqual(ranked.map(o=>o.supplierId),['home_depot','lowes','walmart'],'exact matches rank above candidates, and a known total above an unknown one');
 assert.equal(ranked[0]!.total,11);
 assert.equal(ranked[0]!.totalKnown,true);
 assert.equal(ranked[1]!.total,null,'an unknown shipping cost makes the total unknown rather than optimistic');
 assert.equal(ranked[1]!.subtotal,3);
});

test('offers in another currency are not silently compared',()=>{
 const now=new Date().toISOString();
 const eur=offerSchema.parse({supplierId:'x',supplier:'X',method:'manual',sku:'s',product:'p',url:'https://x.example.test/p',quantity:1,unitPrice:5,currency:'EUR',observedAt:now});
 assert.equal(compareOffers([eur],'USD').length,0);
});

// --- per-supplier normalisation ------------------------------------------

test('Home Depot results normalize, including pickup, delivery and stock',async()=>{
 const offers=await adapterFor('home_depot',{products:[{itemId:'HD-1',title:'M6 bolt 20-pack',canonicalUrl:'https://homedepot.example.test/p/HD-1',pricing:{value:8.47,currency:'USD'},inventory:{quantity:42},availabilityType:'Online and in store',fulfillment:{pickup:{available:true,storeName:'Store #1234',eta:'Ready today'},delivery:{available:true,estimate:'Tue, 3 Jun',charge:5.99}}}]}).search('M6 bolt',2,'USD');
 assert.equal(offers.length,1);
 const o=offers[0]!;
 assert.equal(o.supplierId,'home_depot');
 assert.equal(o.supplier,'The Home Depot');
 assert.equal(o.method,'partner_api');
 assert.equal(o.sku,'HD-1');
 assert.equal(o.unitPrice,8.47);
 assert.equal(o.quantity,2);
 assert.equal(o.inventory,42);
 assert.equal(o.shipping,5.99);
 assert.deepEqual(o.pickup,{available:true,eta:'Ready today',location:'Store #1234'});
 assert.equal(o.delivery.available,true);
 assert.equal(o.delivery.eta,'Tue, 3 Jun');
 assert.equal(o.matchQuality,'exact');
 assert.ok(Date.parse(o.observedAt)>0,'every offer carries when it was observed');
});

test("Lowe's results normalize through its own field names",async()=>{
 const offers=await adapterFor('lowes',{products:[{itemNumber:'LW-9',productTitle:'M6 bolt 20-pack',productUrl:'https://lowes.example.test/p/LW-9',price:{current:7.98,currency:'USD',shipping:0},availability:{status:'In Stock',quantity:12,pickup:true,storeName:'Lowe\'s #22',pickupEta:'Ready in 2 hours',delivery:false}}]}).search('M6 bolt',1,'USD');
 const o=offers[0]!;
 assert.equal(o.supplier,"Lowe's");
 assert.equal(o.unitPrice,7.98);
 assert.equal(o.inventory,12);
 assert.equal(o.availability,'In Stock');
 assert.equal(o.pickup.available,true);
 assert.equal(o.delivery.available,false,'a supplier saying no is recorded as no, not as unknown');
 assert.equal(o.shipping,0);
});

test('Amazon Product Advertising results normalize from their nested shape',async()=>{
 const offers=await adapterFor('amazon',{SearchResult:{Items:[{ASIN:'B00TEST',DetailPageURL:'https://amazon.example.test/dp/B00TEST',ItemInfo:{Title:{DisplayValue:'M6 bolt 20-pack'},Features:{DisplayValues:['Stainless steel']}},Offers:{Listings:[{Price:{Amount:9.25,Currency:'USD'},Availability:{Message:'In Stock'},DeliveryInfo:{IsAmazonFulfilled:true}}]}}]}}).search('M6 bolt',1,'USD');
 const o=offers[0]!;
 assert.equal(o.sku,'B00TEST');
 assert.equal(o.unitPrice,9.25);
 assert.equal(o.availability,'In Stock');
 assert.equal(o.delivery.available,true);
 assert.equal(o.specification,'Stainless steel');
 assert.equal(o.method,'official_api');
 assert.equal(o.pickup.available,null,'a channel the supplier does not report stays unknown');
});

test('Walmart results normalize, including its shipping rate',async()=>{
 const offers=await adapterFor('walmart',{items:[{itemId:'WM-5',name:'M6 bolt 20-pack',productUrl:'https://walmart.example.test/ip/WM-5',salePrice:8.12,standardShipRate:4.97,stock:'Available',availableOnline:true,shortDescription:'20 count'}]}).search('M6 bolt',3,'USD');
 const o=offers[0]!;
 assert.equal(o.sku,'WM-5');
 assert.equal(o.unitPrice,8.12);
 assert.equal(o.shipping,4.97);
 assert.equal(o.quantity,3);
 assert.equal(o.availability,'Available');
 assert.equal(o.delivery.available,true);
});

// Nothing is invented to fill a gap: a row that does not carry a price, a name,
// an identifier or a link is not an offer.
test('rows without a real price, name, identifier or link are dropped, not defaulted',async()=>{
 const offers=await adapterFor('walmart',{items:[
  {itemId:'WM-1',name:'Has everything',productUrl:'https://walmart.example.test/ip/WM-1',salePrice:5},
  {itemId:'WM-2',name:'No price',productUrl:'https://walmart.example.test/ip/WM-2'},
  {itemId:'WM-3',productUrl:'https://walmart.example.test/ip/WM-3',salePrice:5},
  {name:'No id',productUrl:'https://walmart.example.test/ip/WM-4',salePrice:5},
  {itemId:'WM-5',name:'Bad link',productUrl:'not-a-url',salePrice:5},
 ]}).search('Has everything',1,'USD');
 assert.equal(offers.length,1,'one malformed row does not lose the supplier its good rows, and is not filled in');
 assert.equal(offers[0]!.sku,'WM-1');
});

// --- owner-configured suppliers ------------------------------------------

function withSupplierConfig<T>(value:string|undefined,fn:()=>T):T{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-sup-')),file=path.join(dir,'suppliers.json'),before=process.env.SUPPLIER_CONFIG_PATH;
 try{if(value===undefined)delete process.env.SUPPLIER_CONFIG_PATH;else{writeFileSync(file,value);process.env.SUPPLIER_CONFIG_PATH=file;}return fn();}
 finally{if(before===undefined)delete process.env.SUPPLIER_CONFIG_PATH;else process.env.SUPPLIER_CONFIG_PATH=before;rmSync(dir,{recursive:true,force:true});}
}
const localSupplier={id:'riverside_supply',name:'Riverside Building Supply',method:'partner_api',endpoint:'https://riverside.example.test/api/search?q={query}',auth:{type:'bearer',env:'RIVERSIDE_TOKEN'},mapping:{items:'results',sku:'code',product:'title',url:'link',unitPrice:'price'}};

test('a local supplier is configured, not hardcoded',()=>{
 withSupplierConfig(JSON.stringify([localSupplier,{...localSupplier,id:'acme_specialty',name:'Acme Specialty Fasteners'}]),()=>{
  const {configs,error}=configuredSuppliers();
  assert.equal(error,undefined);
  assert.deepEqual(configs.map(c=>c.id),['riverside_supply','acme_specialty']);
  assert.equal(configs[0]!.name,'Riverside Building Supply');
 });
});

test('an invalid supplier file disables only the configured suppliers',()=>{
 for(const body of ['{not json',JSON.stringify([{id:'x'}]),JSON.stringify([{...localSupplier,endpoint:'http://riverside.example.test/api'}]),JSON.stringify([localSupplier,localSupplier])]){
  withSupplierConfig(body,()=>{
   const {configs,error}=configuredSuppliers();
   assert.deepEqual(configs,[]);
   assert.match(error??'',/connected suppliers remain available/);
  });
 }
});

test('a supplier endpoint must be encrypted, unless it is on this machine',()=>{
 assert.equal(isSecureEndpoint('https://riverside.example.test/api'),true);
 assert.equal(isSecureEndpoint('http://riverside.example.test/api'),false,'a remote plaintext endpoint would leak the credential and the prices');
 // Loopback only, on the same reasoning browsers use for http://127.0.0.1:
 // the traffic never leaves the host. This is what a sidecar signing proxy needs.
 assert.equal(isSecureEndpoint('http://127.0.0.1:8099/search'),true);
 assert.equal(isSecureEndpoint('http://localhost:8099/search'),true);
 assert.equal(isSecureEndpoint('not a url'),false);
});

test('a configured supplier without its credential is not searched',async()=>{
 const before=process.env.RIVERSIDE_TOKEN;delete process.env.RIVERSIDE_TOKEN;
 try{
  const adapter=new CatalogAdapter(supplierConfigSchema.parse(localSupplier));
  assert.equal(adapter.configured(),false);
  const {suppliers}=await searchSuppliers([adapter],'bolt',1,'USD');
  assert.equal(suppliers[0]!.status,'unconfigured');
  assert.match(suppliers[0]!.detail!,/RIVERSIDE_TOKEN/);
 }finally{if(before!==undefined)process.env.RIVERSIDE_TOKEN=before;}
});

// --- eBay stays optional --------------------------------------------------

test('eBay is not a supplier unless it is explicitly switched on',async()=>{
 const saved={EBAY_ENABLED:process.env.EBAY_ENABLED,EBAY_CLIENT_ID:process.env.EBAY_CLIENT_ID,EBAY_CLIENT_SECRET:process.env.EBAY_CLIENT_SECRET};
 try{
  // Credentials alone must not be enough: presence is not consent.
  process.env.EBAY_CLIENT_ID='id';process.env.EBAY_CLIENT_SECRET='secret';delete process.env.EBAY_ENABLED;
  assert.equal(new EbayBrowse().configured(),false,'credentials present but not switched on');
  const off=await searchSuppliers([new EbayBrowse()],'bolt',1,'USD');
  assert.equal(off.suppliers[0]!.status,'unconfigured');
  assert.equal(off.offers.length,0);

  process.env.EBAY_ENABLED='true';
  assert.equal(new EbayBrowse().configured(),true,'switched on with credentials');
  process.env.EBAY_ENABLED='false';
  assert.equal(new EbayBrowse().configured(),false);
 }finally{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('the default registry contains no supplier the owner has not connected',()=>{
 const saved=Object.fromEntries(['EBAY_ENABLED','EBAY_CLIENT_ID','EBAY_CLIENT_SECRET','HOME_DEPOT_ENDPOINT','LOWES_ENDPOINT','AMAZON_ENDPOINT','WALMART_ENDPOINT','SUPPLIER_CONFIG_PATH'].map(k=>[k,process.env[k]]));
 try{
  for(const k of Object.keys(saved))delete process.env[k];
  assert.deepEqual(loadSuppliers().adapters.map(a=>a.id),[],'nothing is instantiated by default');
  process.env.HOME_DEPOT_ENDPOINT='https://partner.example.test/search?q={query}';
  assert.deepEqual(loadSuppliers().adapters.map(a=>a.id),['home_depot']);

  // Credentials present but the switch off: eBay is not constructed at all, so
  // it cannot appear in a search report and cannot pad the supplier count.
  process.env.EBAY_CLIENT_ID='id';process.env.EBAY_CLIENT_SECRET='secret';
  assert.deepEqual(optionalSuppliers(),[]);
  assert.deepEqual(loadSuppliers(optionalSuppliers()).adapters.map(a=>a.id),['home_depot']);

  process.env.EBAY_ENABLED='true';
  assert.deepEqual(loadSuppliers(optionalSuppliers()).adapters.map(a=>a.id).sort(),['ebay','home_depot'],'switched on, it joins the others as one supplier among several');
 }finally{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

// --- purchase safety ------------------------------------------------------

const quoteFor=(over:Record<string,unknown>={})=>({supplier:'The Home Depot',quoteId:'q-1',items:[{sku:'HD-1',name:'M6 bolt 20-pack',quantity:2,unitPrice:8.47}],subtotal:16.94,tax:1.35,fees:0,delivery:5.99,total:24.28,currency:'USD',fulfillment:'Delivery Tue, 3 Jun',deliveryAddress:'Site',expiresAt:new Date(Date.now()+3600_000).toISOString(),...over});

/**
 * One quote object flows through quote(), refresh() and the approved arguments.
 * Regenerating it per call would differ by its expiry timestamp alone, and every
 * test below would then pass on "quote differs from the supplier record" instead
 * of the rule it is actually about.
 */
function purchaseHarness(base:Record<string,unknown>,supplier:Partial<SupplierCheckout>={}){
 const db=new Store(':memory:'),t=new ToolGateway(db);db.put('a','run',{id:'r',status:'working'});db.put('a','cart',{id:'cart',items:[]});
 const orders={n:0};
 registerSupplier(t,db,{quote:async()=>base as any,refresh:async()=>base as any,order:async()=>{orders.n++;return {orderNumber:'ORD-1',receiptUrl:'https://supplier.example.test/r/1',status:'ordered'};},...supplier} as SupplierCheckout);
 return {db,t,orders};
}
/** Quote, approve, then attempt the purchase -- the sequence every rule below tests. */
async function approveAndBuy(t:ToolGateway,base:Record<string,unknown>,change:Record<string,unknown>={}){
 const saved=await t.invoke('a','r','purchase_quote',{cartId:'cart'},'q');
 const args={...base,id:saved.id};
 const pending=await t.invoke('a','r','purchase_order',args,'buy');
 assert.ok(pending.approvalId,'buying asks first');
 t.decide('a',pending.approvalId,'once');
 return ()=>t.invoke('a','r','purchase_order',{...args,...change},'buy');
}

test('a purchase never happens without an approval',async()=>{
 const base=quoteFor();const {db,t,orders}=purchaseHarness(base);
 const saved=await t.invoke('a','r','purchase_quote',{cartId:'cart'},'q');
 const pending=await t.invoke('a','r','purchase_order',{...base,id:saved.id},'buy');
 assert.ok(pending.approvalId,'buying asks first');
 assert.equal(orders.n,0,'no order was placed while it was pending');
 assert.equal(db.list('a','order').length,0);
 db.close();
});

test('an approved purchase at unchanged terms does go through',async()=>{
 const base=quoteFor();const {db,t,orders}=purchaseHarness(base);
 const buy=await approveAndBuy(t,base);
 const order=await buy();
 assert.equal(orders.n,1);
 assert.equal(order.orderNumber,'ORD-1');
 assert.equal(db.list('a','order').length,1,'the receipt is kept as an artifact of the purchase');
 db.close();
});

test('a price that moved since approval cannot be bought',async()=>{
 const base=quoteFor();let current:Record<string,unknown>=base;
 const {db,t,orders}=purchaseHarness(base,{refresh:async()=>current as any});
 const buy=await approveAndBuy(t,base);
 current={...base,total:31.15,delivery:12.86};
 await assert.rejects(buy,/Price, stock or fulfillment changed/);
 assert.equal(orders.n,0);
 db.close();
});

test('an expired quote cannot be bought even with a fresh approval',async()=>{
 const base=quoteFor({expiresAt:new Date(Date.now()+400).toISOString()});
 const {db,t,orders}=purchaseHarness(base);
 const buy=await approveAndBuy(t,base);
 await new Promise(r=>setTimeout(r,500));
 await assert.rejects(buy,/Price, stock or fulfillment changed/);
 assert.equal(orders.n,0,'an expired quote buys nothing');
 db.close();
});

// The approval authorises one exact basket, and is bound to those exact
// arguments by hash. A changed basket is refused before the quote is even
// re-read, and starting a fresh request does not inherit the old decision.
test('changing the item, quantity, supplier or total invalidates the approval',async()=>{
 for(const [label,change] of [
  ['quantity',{items:[{sku:'HD-1',name:'M6 bolt 20-pack',quantity:9,unitPrice:8.47}]}],
  ['item',{items:[{sku:'HD-OTHER',name:'M8 bolt',quantity:2,unitPrice:8.47}]}],
  ['supplier',{supplier:'Somewhere Else'}],
  ['total',{total:99.99}],
 ] as [string,Record<string,unknown>][]){
  const base=quoteFor();const {db,t,orders}=purchaseHarness(base);
  const buy=await approveAndBuy(t,base,change);
  await assert.rejects(buy,/Action details changed/,`${label}: the approved arguments are what was authorised`);
  assert.equal(orders.n,0,`${label}: nothing was ordered`);

  // And it cannot be slipped through as a new request either: that asks again.
  const saved=db.list('a','quote')[0]!;
  const retry=await t.invoke('a','r','purchase_order',{...base,...change,id:saved.id},`buy-${label}`);
  assert.ok(retry.approvalId,`${label}: changed terms need their own approval`);
  assert.equal(orders.n,0,`${label}: still nothing ordered`);
  db.close();
 }
});

test('a supplier that fails to place the order produces no order record and no false success',async()=>{
 const base=quoteFor();const {db,t,orders}=purchaseHarness(base,{order:async()=>{throw Error('supplier rejected the card');}});
 const buy=await approveAndBuy(t,base);
 await assert.rejects(buy);
 assert.equal(db.list('a','order').length,0,'no order is recorded when the supplier did not place one');
 assert.equal(orders.n,0);
 db.close();
});

test('a supplier receipt that is not a real receipt is rejected',async()=>{
 const base=quoteFor();const {db,t}=purchaseHarness(base,{order:async()=>({orderNumber:'',receiptUrl:'not-a-url',status:'ordered'}) as any});
 const buy=await approveAndBuy(t,base);
 await assert.rejects(buy);
 assert.equal(db.list('a','order').length,0);
 db.close();
});

// --- the search tool ------------------------------------------------------

test('a search reports which suppliers answered and which did not',async()=>{
 const db=new Store(':memory:'),t=new ToolGateway(db);db.put('a','run',{id:'r',status:'working'});
 registerProcurement(t,db,[stub('home_depot','The Home Depot',[{unitPrice:8.47,shipping:0,tax:0,fees:0}]),stub('lowes',"Lowe's",[],'throw')]);
 const result=await t.invoke('a','r','products_search',{description:'M6 bolt',quantity:2},'s');
 assert.equal(result.searched,2);
 assert.equal(result.succeeded,1);
 assert.equal(result.offers.length,1);
 assert.equal(result.suppliers.find((s:any)=>s.id==='lowes').status,'failed');
 assert.ok(result.offers[0].observedAt,'the comparison carries when each price was seen');
 assert.equal(db.list('a','material').length,1,'the material request is recorded');
 db.close();
});

test('a search where no supplier answers is an error, not an empty result that looks complete',async()=>{
 const db=new Store(':memory:'),t=new ToolGateway(db);db.put('a','run',{id:'r',status:'working'});
 registerProcurement(t,db,[stub('home_depot','The Home Depot',[],'throw')]);
 await assert.rejects(()=>t.invoke('a','r','products_search',{description:'M6 bolt'},'s'),/No supplier answered/);
 db.close();
});

test('searching with nothing connected says so instead of returning nothing',async()=>{
 const db=new Store(':memory:'),t=new ToolGateway(db);db.put('a','run',{id:'r',status:'working'});
 registerProcurement(t,db,[]);
 await assert.rejects(()=>t.invoke('a','r','products_search',{description:'M6 bolt'},'s'),/No suppliers are connected/);
 db.close();
});

test('the connected supplier list names how each one is reached',async()=>{
 const db=new Store(':memory:'),t=new ToolGateway(db);db.put('a','run',{id:'r',status:'working'});
 registerProcurement(t,db,[stub('home_depot','The Home Depot',[{}])]);
 const list=await t.invoke('a','r','suppliers_list',{},'l');
 assert.deepEqual(list.map((s:any)=>({id:s.id,method:s.method,connected:s.connected})),[{id:'home_depot',method:'official_api',connected:true}]);
 db.close();
});

test('a cart records every supplier it spans, since each quotes separately',async()=>{
 const db=new Store(':memory:'),t=new ToolGateway(db);db.put('a','run',{id:'r',status:'working'});
 registerProcurement(t,db,[stub('home_depot','The Home Depot',[{unitPrice:8.47,shipping:0,tax:0,fees:0}]),stub('walmart','Walmart',[{unitPrice:8.12,shipping:0,tax:0,fees:0}])]);
 const search=await t.invoke('a','r','products_search',{description:'M6 bolt'},'s');
 const cart=await t.invoke('a','r','cart_build',{offerIds:search.offers.map((o:any)=>o.id)},'c');
 assert.deepEqual([...cart.suppliers].sort(),['home_depot','walmart']);
 db.close();
});

// --- offers read on a supplier's own website ------------------------------

// A supplier with no API or feed (Menards, a manufacturer's own store) can
// still be compared: the employee reads the offer in a browser the owner can
// watch and records what the page showed. It must say where it came from, must
// not pretend to be a verified match, and must never be buyable through checkout.
test('an offer read on a website joins the comparison, marked as such, and cannot be checked out',async()=>{
 const db=new Store(':memory:'),t=new ToolGateway(db);db.put('a','run',{id:'r',status:'working'});db.put('b','run',{id:'rb',status:'working'});
 registerProcurement(t,db,[stub('home_depot','The Home Depot',[{unitPrice:8.47,shipping:0,tax:0,fees:0}])]);
 const search=await t.invoke('a','r','products_search',{description:'M6 bolt',quantity:1},'s');
 const read=await t.invoke('a','r','offer_record',{requestId:search.requestId,supplier:'Menards',product:'M6 x 20 bolt, 20-pack',url:'https://www.menards.com/p/m6-bolt',unitPrice:6.99,availability:'In stock at store',pickup:'Today'},'o');
 assert.equal(read.requestId,search.requestId,'it joins the comparison that was already running');
 const offer=db.get('a','offer',read.offerId)!;
 assert.equal(offer.method,'browser','it says it was read from the site');
 assert.equal(offer.matchQuality,'unverified','and does not pretend to be a verified match');
 assert.equal(offer.shipping,null,'what the page did not show stays unknown, not zero');
 assert.ok(offer.observedAt,'it carries when the price was seen');
 assert.deepEqual(read.offers.map((o:any)=>o.supplier).sort(),['Menards','The Home Depot']);
 const material=db.get('a','material',search.requestId)!;
 assert.ok(material.suppliers.some((s:any)=>s.name==='Menards'&&s.method==='browser'&&s.status==='ok'),'the comparison names the site it was read from');
 assert.match(read.note,/cannot be bought through checkout/);
 assert.equal([...t.tools.keys()].some(k=>k.startsWith('purchase_order')),false,'no checkout exists for it to be bought through');
 await assert.rejects(()=>t.invoke('b','rb','offer_record',{requestId:search.requestId,supplier:'Menards',product:'x',url:'https://www.menards.com/p/x',unitPrice:1},'ob'),/not found/,'another owner cannot add to your comparison');
 await assert.rejects(()=>t.invoke('a','r','offer_record',{supplier:'X',product:'x',url:'javascript:alert(1)',unitPrice:1},'bad'),'only a real web address');
 db.close();
});

// "3 inch" and "3 in." are the same screw; a 2 in. screw is not. Units, plurals
// and filler words are compared in one form, and a size counts even as one digit.
test('match scoring reads sizes and plurals the way people write them',()=>{
 const title='3 in. #10 Exterior Deck Screws (5 lb box)';
 for(const query of ['3 inch deck screws','3 in. deck screws','deck screw','5 pound box of deck screws'])assert.equal(scoreMatch(query,title).matchQuality,'exact',query);
 assert.equal(scoreMatch('2 inch deck screws',title).matchQuality,'candidate','a different size is only a possible match');
 assert.equal(scoreMatch('brass fittings','Brass compression fitting').matchQuality,'exact','"brass" is not a plural');
 assert.equal(scoreMatch('Moen 1222 cartridge',title).matchQuality,'unverified');
});
