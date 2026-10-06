import {z} from 'zod';
/**
 * The fast router: what kind of task this is, decided before any agent runtime starts, so the gateway can act on
 * it at once -- open the live browser, start a quick search -- instead of waiting for a model to decide to.
 *
 * Two layers. The rules below answer in well under a millisecond and are always used. When TYPESAFE_API_KEY is
 * set, Jev (TypeSafe's judgment model: typed multiple-choice answers in one pass, no text generation) is asked to
 * pick the route for tasks the rules could only guess at, under a hard time limit; if it is slow, down, unsure or
 * unset, the rules' answer stands. A route never grants anything: approvals are still decided per action by the
 * ToolGateway, whatever the router said.
 */
export const ROUTES=['quick_answer','search_then_answer','visible_browser','procurement_browser','connected_app','approval_action'] as const;
export type RouteName=typeof ROUTES[number];
export interface Route{route:RouteName;needsVisibleBrowser:boolean;parallelFastSearch:boolean;requiresApproval:boolean;
 /** guest: a fresh browser with nothing of the owner's. account: the owner's saved sign-ins, for tasks about their own accounts. */
 session:'guest'|'account';
 /** Where the live browser should start, when the task names a store or a site. */
 startUrl?:string;query:string;source:'rules'|'jev';confidence:number;latencyMs:number}

const STORES:[RegExp,string,(q:string)=>string][]=[
 [/\bhome ?depot\b/i,'The Home Depot',q=>`https://www.homedepot.com/s/${encodeURIComponent(q)}`],
 [/\blowe'?s\b/i,"Lowe's",q=>`https://www.lowes.com/search?searchTerm=${encodeURIComponent(q)}`],
 [/\bamazon\b/i,'Amazon',q=>`https://www.amazon.com/s?k=${encodeURIComponent(q)}`],
 [/\bwalmart\b/i,'Walmart',q=>`https://www.walmart.com/search?q=${encodeURIComponent(q)}`],
 [/\bmenards\b/i,'Menards',q=>`https://www.menards.com/main/search.html?search=${encodeURIComponent(q)}`],
 [/\bace hardware\b/i,'Ace Hardware',q=>`https://www.acehardware.com/search?query=${encodeURIComponent(q)}`],
];
const PROCUREMENT=/\b(price|prices|pricing|cost|costs|cheapest|cheaper|buy|order|purchase|in stock|stock|availability|available|supplier|suppliers|vendor|vendors|materials?|lumber|drywall|plywood|shingles?|paint|fixture|faucet|cartridge|filter|breaker|tile|grout|caulk|screws?|bolts?|nails|pipe|fitting|quote)\b/i;
const BROWSE=/\b(website|web ?site|webpage|open (the )?(site|page|website)|go to|visit|fill (out|in)|form|sign up|book|booking|reserve|log ?in|look up on|on their site|warranty|permit|portal|track (my|the) (order|package|shipment)|https?:\/\/|www\.)\b/i;
const CURRENT=/\b(today|tonight|this week|latest|current|currently|now|news|open now|hours|near me|nearby|weather|forecast|score|search|look up|lookup|find|research|compare|reviews?|who is|what is the|how much)\b/i;
const APPS=/\b(gmail|inbox|e-?mail|outlook|calendar|meeting|slack|teams|discord|notion|google (sheet|doc)s?|spreadsheet)\b/i;
const ACTIONS=/\b(send|text|call|pay|checkout|check out|place (the |an )?order|delete|cancel|transfer|wire)\b/i;
// "my account", "my order", "log in": the task is about the owner's own account on a site.
// Pro Xtra and Lowe's Pro volume (VPP) pricing, and staging a cart, only exist signed in.
const ACCOUNT=/\b(my|our) (account|order|orders|subscription|bill|billing|portal|profile|cart|reservation|booking)s?\b|\blog ?in\b|\bsign ?in\b|\bsigned in\b|\bpro ?xtra\b|\bvolume pric|\bvpp\b|\bpro pric|\b(stage|staging|build|add (it |them |these |this )?to) (the |my |a )?cart\b/i;

/** The words to search for: the request minus the polite framing and the store name. */
export function searchQuery(task:string):string{
 let q=task.replace(/https?:\/\/\S+/g,' ');
 for(const [re] of STORES)q=q.replace(re,' ');
 q=q.replace(/\b(please|can you|could you|i need( you)? to|i want( you)? to|help me|for me|find( me)?|look up|search( for)?|check|get( me)?|what('s| is| are)?( the)?|show me|at|on|from|in stock)\b/gi,' ');
 return q.replace(/[?!.,]+/g,' ').replace(/\s+/g,' ').trim().slice(0,200)||task.slice(0,200);
}

/** What to type into a store's own search box: the product, without the asking about it. */
export const productQuery=(q:string)=>q.replace(/\b(prices?|pricing|costs?|cheapest|availability|available|stock|near me|nearby)\b/gi,' ').replace(/\s+/g,' ').trim().replace(/^((for|of|on|the|a|an|some)\s+)+|(\s+(for|of|on|the|a|an))+$/gi,'').trim()||q;
export function ruleRoute(task:string):Omit<Route,'latencyMs'|'source'>&{certain:boolean}{
 const t=task.toLowerCase(),query=searchQuery(task),store=STORES.find(([re])=>re.test(t)),session:Route['session']=ACCOUNT.test(t)?'account':'guest';
 const url=t.match(/https?:\/\/[^\s<>"']+/)?.[0];
 const base={query,session,requiresApproval:false,confidence:0.9};
 if(ACTIONS.test(t)&&!PROCUREMENT.test(t)&&!BROWSE.test(t))return {...base,route:APPS.test(t)?'connected_app':'approval_action',needsVisibleBrowser:false,parallelFastSearch:false,requiresApproval:true,certain:true};
 if(APPS.test(t)&&!store&&!url)return {...base,route:'connected_app',needsVisibleBrowser:false,parallelFastSearch:false,certain:true};
 if(store||PROCUREMENT.test(t)&&CURRENT.test(t)||PROCUREMENT.test(t)&&/\b(price|prices|pricing|cost|cheapest|in stock|stock|availability|supplier|vendor|quote)\b/i.test(t))
  return {...base,route:'procurement_browser',needsVisibleBrowser:true,parallelFastSearch:true,startUrl:url??store?.[2](productQuery(query)),certain:true};
 if(url||BROWSE.test(t))return {...base,route:'visible_browser',needsVisibleBrowser:true,parallelFastSearch:!url,startUrl:url,certain:true};
 if(CURRENT.test(t))return {...base,route:'search_then_answer',needsVisibleBrowser:true,parallelFastSearch:true,certain:false,confidence:0.6};
 return {...base,route:'quick_answer',needsVisibleBrowser:false,parallelFastSearch:false,certain:false,confidence:0.5};
}

const JEV_OPTIONS:Record<RouteName,string>={
 quick_answer:'Answerable from general knowledge or the conversation; no web, apps or actions needed',
 search_then_answer:'Needs current or factual information from the web, answered from search results',
 visible_browser:'Needs a website opened and used: reading a specific site, filling a form, booking, a portal',
 procurement_browser:'About buying or pricing materials, products or parts: prices, stock, suppliers, stores',
 connected_app:'About the owner\'s email, calendar, chat, documents or spreadsheets in a connected app',
 approval_action:'Asks to send, pay, delete, order or otherwise act on the world on the owner\'s behalf',
};
export const jevEnabled=()=>!!process.env.TYPESAFE_API_KEY&&process.env.JEV_ENABLED!=='false';
const jevBase=()=>(process.env.TYPESAFE_API_BASE??'https://api.typesafe.ai').replace(/\/$/,'');
const answerSchema=z.object({answers:z.object({route:z.object({choice:z.string(),confidence:z.number().optional(),probabilities:z.record(z.string(),z.number()).optional()})})});
/** Jev's pick, or null when it is off, slow, failing or not sure enough to act on. Never throws. */
export async function jevRoute(task:string,http:typeof fetch=fetch,timeoutMs=Number(process.env.JEV_TIMEOUT_MS??700)):Promise<{route:RouteName;confidence:number}|null>{
 if(!jevEnabled())return null;
 try{
  const r=await http(`${jevBase()}/v1/systemone`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{Authorization:`Bearer ${process.env.TYPESAFE_API_KEY}`,'Content-Type':'application/json'},
   body:JSON.stringify({model:process.env.JEV_MODEL??'jev-latest',state:{request:task.slice(0,2000)},questions:{route:{type:'choice',instructions:'Which kind of task is this request, for a field and property work assistant on a phone?',criteria:JEV_OPTIONS}}})});
  if(!r.ok)return null;
  const a=answerSchema.parse(await r.json()).answers.route;
  if(!(ROUTES as readonly string[]).includes(a.choice))return null;
  const confidence=a.confidence??a.probabilities?.[a.choice]??0;
  return confidence>=Number(process.env.JEV_MIN_CONFIDENCE??0.6)?{route:a.choice as RouteName,confidence}:null;
 }catch{return null;}
}

/** Route a task: the rules at once, and Jev only where the rules were guessing. */
export async function routeTask(task:string,http:typeof fetch=fetch):Promise<Route>{
 const started=performance.now(),rules=ruleRoute(task);const {certain,...base}=rules;
 if(certain||!jevEnabled())return {...base,source:'rules',latencyMs:Math.round(performance.now()-started)};
 const jev=await jevRoute(task,http);
 if(!jev||jev.route===base.route)return {...base,source:jev?'jev':'rules',confidence:jev?.confidence??base.confidence,latencyMs:Math.round(performance.now()-started)};
 const web=['search_then_answer','visible_browser','procurement_browser'].includes(jev.route);
 return {...base,route:jev.route,needsVisibleBrowser:web,parallelFastSearch:web&&jev.route!=='visible_browser',requiresApproval:['approval_action','connected_app'].includes(jev.route)&&ACTIONS.test(task),source:'jev',confidence:jev.confidence,latencyMs:Math.round(performance.now()-started)};
}
