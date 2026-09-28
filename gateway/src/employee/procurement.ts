import {z} from 'zod';import {Store} from './db.js';import {Refused,ToolGateway,canonical} from './tools.js';import {providerJson} from './communications.js';
import {compareOffers,loadSuppliers,offerSchema,scoreMatch,searchSuppliers,type Offer,type SupplierAdapter} from './suppliers.js';
export {compareOffers,offerSchema,type Offer} from './suppliers.js';

/**
 * eBay is a resale marketplace, not a launch supplier. It stays available as an
 * optional connection but is never instantiated by default: it is added only
 * when the owner switches EBAY_ENABLED on, so it can neither be the default
 * supplier nor the only one a search reaches.
 */
export class EbayBrowse implements SupplierAdapter{
 readonly id='ebay';readonly name='eBay';readonly method='official_api' as const;readonly requires=['EBAY_ENABLED','EBAY_CLIENT_ID','EBAY_CLIENT_SECRET'];
 constructor(readonly http:typeof fetch=fetch){}
 configured(){return process.env.EBAY_ENABLED==='true'&&!!process.env.EBAY_CLIENT_ID&&!!process.env.EBAY_CLIENT_SECRET;}
 async search(query:string,quantity:number,currency:string):Promise<Offer[]>{const id=process.env.EBAY_CLIENT_ID,secret=process.env.EBAY_CLIENT_SECRET;if(!this.configured())throw Error('eBay is not connected');
  const auth=await providerJson('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(id+':'+secret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',scope:'https://api.ebay.com/oauth/api_scope'})},this.http);
  const result=await providerJson('https://api.ebay.com/buy/browse/v1/item_summary/search?'+new URLSearchParams({q:query,limit:'12'}),{headers:{Authorization:`Bearer ${auth.access_token}`,'X-EBAY-C-MARKETPLACE-ID':process.env.EBAY_MARKETPLACE??'EBAY_US'}},this.http);
  const observedAt=new Date().toISOString();
  return (result.itemSummaries??[]).filter((o:any)=>o.price&&o.itemId&&o.title&&o.itemWebUrl).flatMap((o:any)=>{
   const parsed=offerSchema.safeParse({supplierId:this.id,supplier:'eBay / '+(o.seller?.username??'seller'),method:this.method,sku:String(o.itemId),product:String(o.title),url:o.itemWebUrl,quantity,unitPrice:Number(o.price.value),currency:o.price.currency??currency,
    shipping:o.shippingOptions?.[0]?.shippingCost?Number(o.shippingOptions[0].shippingCost.value):null,
    availability:'Listed; quantity and compatibility must be verified',
    delivery:{available:null,eta:o.shippingOptions?.[0]?.maxEstimatedDeliveryDate??'',location:''},
    observedAt,...scoreMatch(query,String(o.title))});
   return parsed.success?[parsed.data]:[];
  });
 }
}

/**
 * Optional suppliers are constructed only once the owner has switched them on.
 * A supplier that is merely available must not appear in the registry at all:
 * listing it in every search as "not connected" inflates the denominator, so
 * "1 of 3 answered" would read as two failures when only one supplier failed.
 */
export function optionalSuppliers(http:typeof fetch=fetch):SupplierAdapter[]{
 return process.env.EBAY_ENABLED==='true'?[new EbayBrowse(http)]:[];
}

/**
 * Procurement over every connected supplier. The set searched is whatever the
 * owner has configured -- no supplier is privileged, and a search that reached
 * only some of them says so rather than presenting a short list as complete.
 */
export function registerProcurement(t:ToolGateway,db:Store,adapters?:SupplierAdapter[]){
 const registry=()=>adapters??loadSuppliers(optionalSuppliers()).adapters;
 t.register({id:'products_search',description:'Search connected suppliers and compare current offers',effect:'read',schema:z.object({description:z.string().min(2).max(500),specification:z.string().max(1000).default(''),quantity:z.number().int().min(1).max(1000).default(1),currency:z.string().length(3).default('USD')}),run:async(a,c)=>{
  const connected=registry();
  if(!connected.length)throw Error('No suppliers are connected. Add a supplier before searching.');
  const request=db.create(c.owner,'material',{...a,runId:c.runId});
  const query=`${a.description} ${a.specification}`.trim();
  const {offers,suppliers}=await searchSuppliers(connected,query,a.quantity,a.currency);
  db.put(c.owner,'material',{...db.get(c.owner,'material',request.id)!,suppliers,searchedAt:new Date().toISOString()});
  const saved=offers.map(o=>({...o,...db.create(c.owner,'offer',{...o,requestId:request.id,runId:c.runId})}));
  const reached=suppliers.filter(s=>s.status==='ok').length;
  // A total failure is an error; a partial one is a result with its gaps named.
  if(!reached)throw Error(`No supplier answered. ${suppliers.map(s=>`${s.name}: ${s.detail??s.status}`).join('; ')}`);
  return {requestId:request.id,currency:a.currency,offers:compareOffers(saved,a.currency),suppliers,
   searched:suppliers.length,succeeded:reached,
   note:'Prices and availability are as reported at the time shown. Taxes and stock are only confirmed by a supplier quote.'};
 }});
 t.register({id:'suppliers_list',description:'List connected suppliers and how each is reached',effect:'read',schema:z.object({}),run:async()=>registry().map(s=>({id:s.id,name:s.name,method:s.method,connected:s.configured(),requires:s.requires}))});
 // A supplier with no API or partner feed can still be compared: the employee reads the offer on the
 // supplier's own site, in a browser the owner can watch, and records only what the page showed. It is
 // marked as read from the site and as a weak match, and it can never be bought through checkout --
 // no supplier connection stands behind it to quote an exact total. The owner buys it on the site.
 t.register({id:'offer_record',effect:'write',description:"Add an offer you read yourself on a supplier's website to a price comparison. Record only what the page showed and leave out anything it did not; set requestId to add to an existing comparison.",
  schema:z.object({requestId:z.string().optional(),supplier:z.string().min(1).max(100),product:z.string().min(1).max(300),url:z.string().url().refine(u=>/^https?:\/\//i.test(u),'A web address of the offer'),
   unitPrice:z.number().nonnegative(),quantity:z.number().int().min(1).max(1000).default(1),currency:z.string().length(3).default('USD'),sku:z.string().max(100).optional(),
   availability:z.string().max(200).optional(),shipping:z.number().nonnegative().optional(),tax:z.number().nonnegative().optional(),
   pickup:z.string().max(200).optional(),delivery:z.string().max(200).optional()}),
  run:async(a,c)=>{
   const existing=a.requestId?db.get(c.owner,'material',a.requestId):undefined;
   if(a.requestId&&!existing)throw Error('That comparison was not found');
   const request=existing??db.create(c.owner,'material',{description:a.product,specification:'',quantity:a.quantity,currency:a.currency,runId:c.runId});
   const supplierId=`browser:${a.supplier.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'site'}`,observedAt=new Date().toISOString();
   const offer=offerSchema.parse({supplierId,supplier:a.supplier,method:'browser',sku:a.sku??'not shown',product:a.product,url:a.url,quantity:a.quantity,unitPrice:a.unitPrice,currency:a.currency,
    shipping:a.shipping??null,tax:a.tax??null,availability:a.availability??'unconfirmed',observedAt,matchQuality:'unverified',confidence:0.4,
    pickup:{available:a.pickup?true:null,eta:a.pickup??'',location:''},delivery:{available:a.delivery?true:null,eta:a.delivery??'',location:''}});
   const saved=db.create(c.owner,'offer',{...offer,requestId:request.id,runId:c.runId});
   // The comparison names every supplier it covers, so one read from a website is counted like any other.
   const current=db.get(c.owner,'material',request.id)!,others=(current.suppliers??[]).filter((x:any)=>x.id!==supplierId);
   const count=db.list(c.owner,'offer').filter(o=>o.requestId===request.id&&o.supplierId===supplierId).length;
   db.put(c.owner,'material',{...current,suppliers:[...others,{id:supplierId,name:a.supplier,method:'browser',status:'ok',offers:count,checkedAt:observedAt}],searchedAt:observedAt});
   const all=db.list(c.owner,'offer').filter(o=>o.requestId===request.id);
   return {requestId:request.id,offerId:saved.id,offers:compareOffers(all as unknown as Offer[],a.currency),
    note:'Read from the website: it cannot be bought through checkout. The owner can buy it on the site, and can take the browser over to do it.'};
  }});
 t.register({id:'cart_build',description:'Save selected products in a cart for review',effect:'write',schema:z.object({offerIds:z.array(z.string()).min(1).max(30)}),run:async(a,c)=>{const items=a.offerIds.map((id:string)=>db.get(c.owner,'offer',id));if(items.some((x:any)=>!x))throw Error('Offer not found');
  // A cart spanning suppliers cannot be one quote; each supplier quotes its own.
  return db.create(c.owner,'cart',{items,runId:c.runId,status:'draft',suppliers:[...new Set(items.map((i:any)=>i.supplierId))]});}});
 t.register({id:'order_status',description:'Check a placed order',effect:'read',schema:z.object({orderId:z.string()}),run:async(a,c)=>{const order=db.get(c.owner,'order',a.orderId);if(!order)throw Error('Order not found');
  return {orderNumber:order.orderNumber,supplier:order.supplier,status:order.status,total:order.total,currency:order.currency,fulfillment:order.fulfillment,receiptUrl:order.receiptUrl,placedAt:order.createdAt};}});
}
export const quoteSchema=z.object({supplier:z.string().min(1),quoteId:z.string().min(1),items:z.array(z.object({sku:z.string(),name:z.string(),quantity:z.number().int().positive(),unitPrice:z.number().nonnegative()})).min(1),subtotal:z.number().nonnegative(),tax:z.number().nonnegative(),fees:z.number().nonnegative(),delivery:z.number().nonnegative(),total:z.number().nonnegative(),currency:z.string().length(3),fulfillment:z.string(),deliveryAddress:z.string(),expiresAt:z.string().datetime()});
export interface SupplierCheckout{quote(cartId:string,owner:string):Promise<z.infer<typeof quoteSchema>>;refresh(quoteId:string,owner:string):Promise<z.infer<typeof quoteSchema>>;order(quoteId:string,key:string,owner:string,beforeCommit?:()=>void):Promise<{orderNumber:string;receiptUrl:string;status:string}>}
export function registerSupplier(t:ToolGateway,db:Store,supplier:SupplierCheckout,connection='supplier',owners?:string[]){const suffix=connection==='supplier'?'':`_${connection}`;
 t.register({id:'purchase_quote'+suffix,owners,description:'Get an exact supplier quote including all costs',effect:'read',schema:z.object({cartId:z.string()}),run:async(a,c)=>{if(!db.get(c.owner,'cart',a.cartId))throw Error('Cart not found');const quote=quoteSchema.parse(await supplier.quote(a.cartId,c.owner));return db.create(c.owner,'quote',{...quote,connection,runId:c.runId});}});
 t.register({id:'purchase_order'+suffix,owners,title:'Buy this',description:'Place the exact purchase shown for approval',effect:'financial',schema:quoteSchema.extend({id:z.string()}),run:async(a,c)=>{
  const saved=db.get(c.owner,'quote',a.id);if(!saved||saved.connection!==connection)throw new Refused('Quote not found');const approved=quoteSchema.parse(a);if(canonical(approved)!==canonical(quoteSchema.parse(saved)))throw new Refused('Quote differs from the supplier record');
  const current=quoteSchema.parse(await supplier.refresh(a.quoteId,c.owner));if(Date.parse(current.expiresAt)<=Date.now()||canonical(current)!==canonical(approved))throw new Refused('Price, stock or fulfillment changed. Request a new quote and approval.');
  const cents=(n:number)=>Math.round(n*100);if(cents(a.subtotal)+cents(a.tax)+cents(a.fees)+cents(a.delivery)!==cents(a.total)||a.items.reduce((n:number,i:any)=>n+cents(i.unitPrice)*i.quantity,0)!==cents(a.subtotal))throw new Refused('Supplier total does not reconcile');
  c.assertAuthorized();const receipt=z.object({orderNumber:z.string().min(1),receiptUrl:z.string().url(),status:z.string()}).parse(await supplier.order(a.quoteId,c.actionId,c.owner,c.assertAuthorized));return db.create(c.owner,'order',{...approved,...receipt,runId:c.runId,approvalActionId:c.actionId,connection});
 }});
}
