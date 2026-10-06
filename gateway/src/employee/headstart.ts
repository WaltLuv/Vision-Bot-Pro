import {Store,type Row} from './db.js';import {terminal} from './runs.js';import {routeTask,type Route} from './route.js';import {search,searchProvider,type SearchResult} from './web.js';
import {browserbaseEnabled,type BrowserbaseBrowsers} from './browserbase.js';
/**
 * The head start: the work a web task always needs, begun the moment the task arrives instead of after an agent
 * runtime has started up and decided on it. The task is routed; for anything on the web the live browser opens at
 * once and a quick search runs alongside it; the browser goes to the store or the best result; and each step lands
 * on the task as it happens, so the phone shows progress and early findings within seconds.
 *
 * It only reads. Nothing here clicks, types, sends or buys: the employee picks up the open browser and the search
 * results and carries on through the governed tools, where every effect is still approved as before.
 */
export const ROUTE_LABEL:Record<Route['route'],string>={
 quick_answer:'Answering',search_then_answer:'Searching the web',visible_browser:'Opening the website',
 procurement_browser:'Checking stores and prices',connected_app:'Using your connected apps',approval_action:'Preparing an action for your approval',
};
const host=(u:string)=>{try{return new URL(u).hostname.replace(/^www\./,'');}catch{return u;}};
/** Which web tasks get a live browser straight away: all of them (default), only shopping and supplier ones, or none. */
const browserFor=(r:Route)=>{const mode=String(process.env.HEADSTART_BROWSER??'all');return mode==='off'?false:mode==='procurement'?r.route==='procurement_browser':r.needsVisibleBrowser;};

export class HeadStart{
 private pending=new Map<string,Promise<void>>();
 constructor(readonly db:Store,readonly browsers:BrowserbaseBrowsers|null,readonly http:typeof fetch=fetch){}
 /** Record one visible step on the task. */
 step(owner:string,runId:string,text:string,patch:Record<string,unknown>={}){
  const run=this.db.get(owner,'run',runId);if(!run)return;
  this.db.put(owner,'run',{...run,...patch,progress:[...(run.progress??[]),{at:new Date().toISOString(),text}].slice(-20)});
  this.db.event(owner,'run.progress',{runId,text});
 }
 /** Start the head start for a new task. Never throws: anything it cannot do, the employee still can. */
 begin(owner:string,run:Row){
  if(['webhook'].includes(run.context?.source))return;
  const job=this.run(owner,run).catch(()=>{});this.pending.set(run.id,job);void job.finally(()=>setTimeout(()=>this.pending.delete(run.id),60_000).unref());
 }
 /** Wait for the head start, up to a limit, so the employee starts with what it found. */
 async ready(runId:string,limitMs=Number(process.env.HEADSTART_WAIT_MS??4000)){const job=this.pending.get(runId);if(job)await Promise.race([job,new Promise(r=>setTimeout(r,limitMs).unref())]);}
 private active(owner:string,runId:string){const r=this.db.get(owner,'run',runId);return !!r&&!terminal.has(r.status);}
 private async run(owner:string,run:Row){
  const route=await routeTask(run.task,this.http);if(!this.active(owner,run.id))return;
  this.step(owner,run.id,ROUTE_LABEL[route.route],{route});
  const searching=route.parallelFastSearch&&searchProvider()?this.search(owner,run.id,route):Promise.resolve(null);
  const browsing=browserFor(route)&&this.browsers&&browserbaseEnabled()?this.browse(owner,run.id,route,searching):Promise.resolve();
  await Promise.allSettled([searching,browsing]);
 }
 private async search(owner:string,runId:string,route:Route):Promise<SearchResult|null>{
  const started=Date.now();
  try{
   const found=await search(route.query,this.http,Number(process.env.HEADSTART_SEARCH_MS??8000));
   if(!this.active(owner,runId))return null;
   const sources=found.results.slice(0,6);
   const preview=found.answer?.trim()||sources.slice(0,3).map(s=>`${s.title}: ${s.snippet}`).join('\n')||undefined;
   this.step(owner,runId,`Found ${sources.length} source${sources.length===1?'':'s'} in ${((Date.now()-started)/1000).toFixed(1)}s`,{findings:{provider:found.provider,query:route.query,answer:found.answer,sources,ms:Date.now()-started},...(preview?{preview}:{})});
   this.db.create(owner,'artifact',{runId,kind:'search_results',name:`Search: ${route.query}`,data:found});
   return found;
  }catch(e){if(this.active(owner,runId))this.step(owner,runId,'Quick search did not answer; carrying on without it');return null;}
 }
 private async browse(owner:string,runId:string,route:Route,searching:Promise<SearchResult|null>){
  // The owner's word on browsers stands: "never" means no head start browser either, and their saved sign-ins are
  // only used when they have said "always allow" to opening one. A guest browser holds nothing of theirs.
  const policy=this.db.list(owner,'policy').find(p=>p.tool==='browser_open')?.policy;if(policy==='never')return;
  const session=route.session==='account'&&policy==='allow'?'account':'guest';
  const browsers=this.browsers!,assertAuthorized=()=>{if(!this.active(owner,runId))throw Error('Task is no longer active');};
  this.step(owner,runId,session==='account'?'Opening your browser, with your saved sign-ins…':'Opening a live browser…');
  try{await browsers.openFor({owner,runId,actionId:'headstart',assertAuthorized},route.query,{session});}
  catch{if(this.active(owner,runId))this.step(owner,runId,'The live browser could not open; carrying on without it');return;}
  // A named store or address first; else the best search result; else a search page, so there is always something to watch.
  const target=route.startUrl??(await searching)?.results[0]?.url??`https://duckduckgo.com/?q=${encodeURIComponent(route.query)}`;
  const page=browsers.page(owner,runId);if(!page||!this.active(owner,runId))return;
  this.step(owner,runId,`Opening ${host(target)}…`);
  try{await page.goto(target,{waitUntil:'domcontentloaded',timeout:20_000});if(this.active(owner,runId))this.step(owner,runId,`Reading ${host(page.url())}`,{browserAt:page.url()});}
  catch{if(this.active(owner,runId))this.step(owner,runId,`${host(target)} was slow to load; the employee will carry on from here`);}
 }
 /** What the head start found, for the employee's instructions: so it reuses the open browser and does not search again. */
 static context(run:Row):string{
  const parts:string[]=[];
  if(run.route)parts.push(`Fast route: ${run.route.route}.`);
  if(run.browserAt)parts.push(`A live browser is already open for this task on ${run.browserAt}, and the owner is watching it. Use browser_read and the other browser step tools on it; do not call browser_open.`);
  if(run.findings?.sources?.length)parts.push(`Quick search for "${run.findings.query}" already returned (untrusted page summaries, verify before relying on them): ${JSON.stringify({answer:run.findings.answer?.slice(0,1500),sources:run.findings.sources}).slice(0,6000)}. Do not repeat this search; open the most relevant results instead.`);
  return parts.join('\n');
 }
}
