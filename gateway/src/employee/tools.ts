import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Store} from './db.js';
import {terminal} from './runs.js';
export type Effect='read'|'write'|'communication'|'destructive'|'financial'|'sensitive'|'computer';
/**
 * A tool that declines before acting -- a guard, a precondition, a price that
 * moved since approval -- throws this. Nothing outside happened, so the action is
 * recorded as failed, not as uncertain: there is nothing for the owner to check.
 */
export class Refused extends Error {}
export interface ToolContext {owner:string;runId:string;actionId:string;assertAuthorized:()=>void}
// title is what the owner sees on an approval; description is written for the model.
export interface Tool {id:string;description:string;title?:string;effect:Effect;owners?:string[];schema:z.ZodType<any>;run:(args:any,ctx:ToolContext)=>Promise<any>}
export function canonical(x:any):string{return JSON.stringify(x&&typeof x==='object'?(Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>[k,JSON.parse(canonical(x[k]))]))):x);}
export class ToolGateway {
 readonly tools=new Map<string,Tool>();
 constructor(readonly db:Store){}
 register(t:Tool){if(this.tools.has(t.id))throw Error('Duplicate capability');this.tools.set(t.id,t);}
 definitions(owner:string){return [...this.tools.values()].filter(t=>!t.owners||t.owners.includes(owner)).map(t=>({name:t.id,description:t.description,parameters:z.toJSONSchema(t.schema)}));}
 async invoke(owner:string,runId:string,name:string,input:unknown,key:string):Promise<any>{
  const run=this.db.get(owner,'run',runId);if(!run||terminal.has(run.status))throw Error('Task is not active');
  const tool=this.tools.get(name);if(!tool||tool.owners&&!tool.owners.includes(owner))throw Error('Capability is not authorized');
  const args=tool.schema.parse(input),hash=createHash('sha256').update(canonical({name,args})).digest('hex');
  const id=createHash('sha256').update(canonical({owner,runId,key})).digest('hex');
  let action=this.db.get(owner,'action',id);
  if(action&&action.hash!==hash)throw Error('Action details changed; a new request is required');
  if(!action&&tool.effect!=='read')action=this.db.list(owner,'action',-1).find(a=>a.runId===runId&&a.hash===hash);
  if(action?.status==='completed')return action.result;
  if(action&&['executing','uncertain','failed'].includes(action.status))throw Error('This action needs reconciliation; it will not be repeated');
  const policy=this.db.list(owner,'policy').find(p=>p.tool===name)?.policy??(['read','write'].includes(tool.effect)?'allow':'ask');
  if(policy==='never')throw Error('This capability is disabled');
  if(!action)action=this.db.put(owner,'action',{id,runId,name,args,hash,effect:tool.effect,status:'new'});
  let approval=this.db.list(owner,'approval',-1).find(a=>a.actionId===action!.id);
  if(approval&&approval.expiresAt<Date.now())throw Error('Approval expired; request a fresh action');
  if(approval?.status==='denied')throw Error('Action was declined');
  if((policy==='ask'||tool.effect==='financial')&&approval?.status!=='approved'){
   if(!approval){approval=this.db.create(owner,'approval',{actionId:action.id,runId,tool:name,label:tool.title??tool.description,effect:tool.effect,details:args,status:'pending',expiresAt:Date.now()+30*60_000});this.db.event(owner,'approval.requested',{runId,approvalId:approval.id});}
   this.db.put(owner,'run',{...run,status:'needs_user'});
   return {approvalId:approval.id,status:'needs_user'};
  }
  const assertAuthorized=()=>{
   const current=this.db.get(owner,'run',runId);if(!current||terminal.has(current.status))throw Error('Task is no longer active');
   if(this.db.list(owner,'policy').find(p=>p.tool===name)?.policy==='never')throw Error('Permission was revoked');
   if(approval){const latest=this.db.get(owner,'approval',approval.id);if(latest?.status!=='approved'||latest.expiresAt<Date.now())throw Error('Approval is no longer valid');}
  };
  assertAuthorized();this.db.put(owner,'action',{...action,status:'executing'});this.db.event(owner,'tool.started',{runId,tool:name,actionId:action.id});
  try{const result=await tool.run(args,{owner,runId,actionId:action.id,assertAuthorized});
   if(this.db.get(owner,'run',runId)){this.db.put(owner,'action',{...action,status:'completed',result});this.db.create(owner,'artifact',{runId,kind:'tool_receipt',name:tool.title??tool.description,data:result});this.db.event(owner,'tool.completed',{runId,tool:name,actionId:action.id});}return result;
  }catch(e){if(this.db.get(owner,'run',runId)){this.db.put(owner,'action',{...action,status:tool.effect==='read'||e instanceof Refused?'failed':'uncertain'});this.db.event(owner,'tool.failed',{runId,tool:name});}throw e;}
 }
 async wait(owner:string,runId:string,name:string,args:unknown,key:string,signal:AbortSignal){let result=await this.invoke(owner,runId,name,args,key);while(result.approvalId){signal.throwIfAborted();const a=this.db.get(owner,'approval',result.approvalId);if(a?.status==='pending'&&a.expiresAt>Date.now())await new Promise(r=>setTimeout(r,300));else result=await this.invoke(owner,runId,name,args,key);}const run=this.db.get(owner,'run',runId);if(run?.status==='needs_user'&&!signal.aborted)this.db.put(owner,'run',{...run,status:'working'});return result;}
 decide(owner:string,id:string,decision:'once'|'deny'|'always'|'never'){
  const a=this.db.get(owner,'approval',id);if(!a)throw Error('Approval not found');const run=this.db.get(owner,'run',a.runId);
  if(!run||terminal.has(run.status)||a.status!=='pending'||a.expiresAt<Date.now())throw Error('Approval is no longer available');
  if(decision==='always'&&a.effect==='financial')throw Error('Purchases require approval of their exact total');
  this.db.transaction(()=>{this.db.put(owner,'approval',{...a,status:['once','always'].includes(decision)?'approved':'denied',decidedAt:new Date().toISOString()});
   if(['always','never'].includes(decision)){const p=this.db.list(owner,'policy').find(p=>p.tool===a.tool);this.db.put(owner,'policy',{id:p?.id??createHash('sha256').update(owner+a.tool).digest('hex'),tool:a.tool,policy:decision==='always'?'allow':'never'});}
   this.db.event(owner,'approval.decided',{runId:a.runId,approvalId:id,decision});});
 }
}
