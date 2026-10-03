import {test} from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../src/employee/db.js';import {ToolGateway} from '../src/employee/tools.js';
import {registerProcurement,registerSupplier,optionalSuppliers,type SupplierCheckout} from '../src/employee/procurement.js';import {loadSuppliers} from '../src/employee/suppliers.js';
import {itemNumber,offersFromAnswer,webPriceChecks,WebPriceCheck} from '../src/employee/webprices.js';import type {GroundedAnswer} from '../src/employee/grounded.js';

/**
 * Prices from the stores' own pages through Google Search, with Gemini and
 * Google's redirect host stood in, answering the way the API does. What is
 * checked is what keeps it honest: a price is kept only when Google ties it to
 * a product page on that store's own site, it says how it was found, and it can
 * never be bought through checkout.
 */
const KEY='fixture-gemini-key-0123456789abcdef';
async function withEnv(env:Record<string,string|undefined>,body:()=>Promise<void>|void){
 const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
 for(const [k,v] of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;
 try{await body();}finally{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}
}
const CLEAN={GEMINI_API_KEY:undefined,GOOGLE_API_KEY:undefined,SEARCH_MODEL:undefined,WEB_PRICE_CHECK:undefined,HOME_DEPOT_ENDPOINT:undefined,LOWES_ENDPOINT:undefined,AMAZON_ENDPOINT:undefined,WALMART_ENDPOINT:undefined,EBAY_ENABLED:undefined,SUPPLIER_CONFIG_PATH:undefined};

const answer=(text:string,sources:{url:string;domain:string}[],supports:{text:string;sources:number[]}[]):GroundedAnswer=>({text,queries:[],sources:sources.map(s=>({title:s.domain,...s})),supports});

test('a price is kept only when Google ties it to a product page on that store\'s own site',()=>{
 const text=[
  '- **OFFER** | Moen Posi-Temp Replacement Cartridge 1222 | $28.98 | In stock at 14 stores near you',
  'OFFER | Moen 1222B Shower Cartridge | $31.47 | not shown',
  'OFFER | Moen Cartridge Assortment | $54.00 | not shown',
  'OFFER | Moen 1222 Cartridge, 2-pack | $49.99 | Ships in 2 days',
 ].join('\n');
 const found=answer(text,[
  {url:'https://www.homedepot.com/p/Moen-Posi-Temp-Replacement-Cartridge-1222/100153536',domain:'homedepot.com'},
  {url:'https://www.lowes.com/pd/Moen-1222B/1000123456',domain:'lowes.com'},
  {url:'https://www.homedepot.com/s/moen%20cartridge',domain:'homedepot.com'},
 ],[
  {text:'OFFER | Moen Posi-Temp Replacement Cartridge 1222 | $28.98 | In stock at 14 stores near you',sources:[0]},
  {text:'OFFER | Moen 1222B Shower Cartridge | $31.47 | not shown',sources:[1]},
  {text:'OFFER | Moen Cartridge Assortment | $54.00 | not shown',sources:[2]},
 ]);
 const {offers,unbacked}=offersFromAnswer(found,'home_depot','Moen 1222 cartridge',2,'2026-10-03T12:00:00.000Z');
 assert.equal(offers.length,1,'only the line a Home Depot product page backs');
 assert.equal(unbacked,3,'a Lowe\'s page, a search-results page and no page at all back nothing here');
 const [o]=offers;
 assert.equal(o!.supplier,'The Home Depot');assert.equal(o!.method,'web_search');assert.equal(o!.supplierId,'web_home_depot');
 assert.equal(o!.unitPrice,28.98);assert.equal(o!.quantity,2);assert.equal(o!.currency,'USD');assert.equal(o!.sku,'100153536');
 assert.equal(o!.url,'https://www.homedepot.com/p/Moen-Posi-Temp-Replacement-Cartridge-1222/100153536','its link is the page Google tied it to');
 assert.equal(o!.availability,'In stock at 14 stores near you (as the page showed; not confirmed)');
 assert.equal(o!.matchQuality,'candidate','every word matched, yet nobody has looked at the item: a possible match');assert.ok(o!.confidence<=0.7);
 assert.equal(o!.shipping,null);assert.equal(o!.tax,null,'what the page did not show stays unknown, not zero');
 assert.equal(o!.inventory,null);assert.equal(o!.observedAt,'2026-10-03T12:00:00.000Z');

 assert.deepEqual(offersFromAnswer(answer('NONE',[],[]),'amazon','x',1),{offers:[],unbacked:0});
 // A link Google's redirect would not reveal is taken on the site Google named; its item number is then unknown.
 const hidden=offersFromAnswer(answer('OFFER | Moen 1222 | $27.10 | not shown',[{url:'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x',domain:'walmart.com'}],[{text:'OFFER | Moen 1222 | $27.10 | not shown',sources:[0]}]),'walmart','Moen 1222',1);
 assert.equal(hidden.offers[0]!.sku,'not shown');assert.equal(hidden.offers[0]!.availability,'unconfirmed');
});

test('store item numbers are read only from product page addresses',()=>{
 assert.equal(itemNumber('home_depot','https://www.homedepot.com/p/Moen-Cartridge-1222/100153536'),'100153536');
 assert.equal(itemNumber('home_depot','https://www.homedepot.com/s/moen?NCNI-5'),null);
 assert.equal(itemNumber('lowes','https://www.lowes.com/pd/Moen-1222/1000123456'),'1000123456');
 assert.equal(itemNumber('amazon','https://www.amazon.com/Moen-1222-Cartridge/dp/B000FBRP7Y?th=1'),'B000FBRP7Y');
 assert.equal(itemNumber('amazon','https://www.amazon.com/gp/aw/d/B000FBRP7Y'),'B000FBRP7Y');
 assert.equal(itemNumber('amazon','https://www.amazon.com/s?k=moen+1222'),null);
 assert.equal(itemNumber('walmart','https://www.walmart.com/ip/Moen-1222/17227593'),'17227593');
 assert.equal(itemNumber('walmart','not a url'),null);
});

/** Gemini answering per store from the prompt it is given, and Google's redirect host. */
function stores(reply:Record<string,{status?:number;text?:string;pages?:{id:string;to:string;title:string}[];backs?:{text:string;pages:number[]}[]}>){
 const calls:string[]=[];
 const http=(async(input:any,init:any={})=>{const url=String(input);
  if(url.includes('generativelanguage.googleapis.com')){const prompt:string=JSON.parse(init.body).contents[0].parts[0].text,domain=/\(([a-z.]+)\)/.exec(prompt)![1]!;calls.push(domain);
   assert.equal(init.headers['x-goog-api-key'],KEY);assert.deepEqual(JSON.parse(init.body).tools,[{google_search:{}}]);
   const r=reply[domain]!;if(r.status)return new Response(JSON.stringify({error:{code:r.status,message:'Resource has been exhausted (e.g. check quota).'}}),{status:r.status});
   const text=r.text??'NONE',pages=r.pages??[];
   return Response.json({candidates:[{content:{parts:[{text}]},groundingMetadata:{webSearchQueries:[`moen 1222 ${domain}`],
    groundingChunks:pages.map(p=>({web:{uri:`https://vertexaisearch.cloud.google.com/grounding-api-redirect/${p.id}`,title:p.title}})),
    groundingSupports:(r.backs??[]).map(b=>({segment:{startIndex:text.indexOf(b.text),endIndex:text.indexOf(b.text)+b.text.length,text:b.text},groundingChunkIndices:b.pages}))}}]});}
  if(url.startsWith('https://vertexaisearch.cloud.google.com/')){const id=url.split('/').pop()!,to=Object.values(reply).flatMap(r=>r.pages??[]).find(p=>p.id===id)!.to;return new Response(null,{status:302,headers:{location:to}});}
  throw Error(`unexpected request to ${url}`);}) as typeof fetch;
 return {http,calls};
}
const HD='OFFER | Moen Posi-Temp Replacement Cartridge 1222 | $28.98 | In stock at 14 stores',LW='OFFER | Moen 1222 Posi-Temp Shower Cartridge | $27.48 | Free store pickup today';

test('a price comparison asks every store at once, names each one\'s outcome, and cannot be bought through checkout',async()=>{
 await withEnv({...CLEAN,GEMINI_API_KEY:KEY},async()=>{
  const {http,calls}=stores({
   'homedepot.com':{text:HD,pages:[{id:'hd',to:'https://www.homedepot.com/p/Moen-Posi-Temp-Replacement-Cartridge-1222/100153536',title:'homedepot.com'}],backs:[{text:HD,pages:[0]}]},
   'lowes.com':{text:LW,pages:[{id:'lw',to:'https://www.lowes.com/pd/Moen-1222-Posi-Temp-Cartridge/1000384551',title:'lowes.com'}],backs:[{text:LW,pages:[0]}]},
   'amazon.com':{text:'NONE'},
   'walmart.com':{status:429},
  });
  const db=new Store(':memory:'),t=new ToolGateway(db);db.put('a','run',{id:'r',status:'working'});
  registerProcurement(t,db,loadSuppliers(optionalSuppliers(http)).adapters);
  const r=await t.invoke('a','r','products_search',{description:'Moen 1222 shower cartridge',quantity:1},'s');
  assert.deepEqual(calls.sort(),['amazon.com','homedepot.com','lowes.com','walmart.com'],'all four stores, each its own search');
  assert.deepEqual(r.offers.map((o:any)=>[o.supplier,o.unitPrice,o.method]),[["Lowe's",27.48,'web_search'],['The Home Depot',28.98,'web_search']],'cheapest first');
  assert.deepEqual(r.suppliers.map((s:any)=>[s.name,s.status,s.offers]),[['The Home Depot','ok',1],["Lowe's",'ok',1],['Amazon','ok',0],['Walmart','failed',0]],'which stores answered, and which did not');
  assert.equal(r.searched,4);assert.equal(r.succeeded,3);
  assert.equal(r.offers[0].url,'https://www.lowes.com/pd/Moen-1222-Posi-Temp-Cartridge/1000384551');
  assert.match(r.note,/web_search are what each store's own page showed.*do not quote or buy them here/,'the employee is told what these prices are, and that they are bought on the store\'s site');

  // Nothing found this way can be bought through a supplier quote, whatever supplier is connected.
  let quoted=0;const checkout:SupplierCheckout={quote:async()=>{quoted++;throw Error('must not be asked');},refresh:async()=>{throw Error('no');},order:async()=>{throw Error('no');}};
  registerSupplier(t,db,checkout);
  const cart=await t.invoke('a','r','cart_build',{offerIds:[r.offers[0].id]},'c');
  await assert.rejects(()=>t.invoke('a','r','purchase_quote',{cartId:cart.id},'q'),/found on the stores' websites.*Buy them on the store's site/);
  assert.equal(quoted,0,'the supplier is never asked to quote it');
  db.close();
 });
});

test('the stores\' web prices are on with a Gemini key, step aside for a partner connection, and can be turned off',async()=>{
 await withEnv(CLEAN,()=>{assert.deepEqual(webPriceChecks(),[]);assert.deepEqual(loadSuppliers(optionalSuppliers()).adapters,[],'no key, nothing listed');});
 await withEnv({...CLEAN,GOOGLE_API_KEY:KEY},()=>{
  assert.deepEqual(loadSuppliers(optionalSuppliers()).adapters.map(a=>[a.id,a.method]),[['web_home_depot','web_search'],['web_lowes','web_search'],['web_amazon','web_search'],['web_walmart','web_search']]);
 });
 await withEnv({...CLEAN,GEMINI_API_KEY:KEY,HOME_DEPOT_ENDPOINT:'https://partner.example.test/search?q={query}',HOME_DEPOT_API_KEY:'x'},()=>{
  assert.deepEqual(loadSuppliers(optionalSuppliers()).adapters.map(a=>a.id),['home_depot','web_lowes','web_amazon','web_walmart'],'a store with a partner connection is priced through it, not by web search');
 });
 await withEnv({...CLEAN,GEMINI_API_KEY:KEY,WEB_PRICE_CHECK:'off'},()=>{assert.deepEqual(webPriceChecks(),[]);});
 // These stores price in dollars: asked for another currency, they answer nothing and Gemini is not asked.
 await withEnv({...CLEAN,GEMINI_API_KEY:KEY},async()=>{
  const check=new WebPriceCheck('amazon',(async()=>{throw Error('must not be called');}) as typeof fetch);
  assert.deepEqual(await check.search('Moen 1222',1,'CAD'),[]);
 });
});
