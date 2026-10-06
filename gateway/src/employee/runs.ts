import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Store,type Row} from './db.js';
export const executeSchema=z.object({task:z.string().trim().min(1).max(12000),title:z.string().trim().min(1).max(200).optional(),context:z.object({agentId:z.string().optional(),conversationId:z.string().optional(),source:z.enum(['phone','glasses','text','workflow','webhook']).default('text'),visualDescription:z.string().max(4000).optional(),attachments:z.array(z.string()).max(8).default([]),workspace:z.string().max(100).optional()}).default({source:'text',attachments:[]})});
export const terminal=new Set(['completed','failed','cancelled']);
export type Executor=(owner:string,run:Row,signal:AbortSignal)=>Promise<{result:string;usage?:unknown}>;
export class RunQueue {
 readonly active=new Map<string,AbortController>();
 /** Called once for each new task, after it is saved and before it runs: the head start hangs off this. */
 onCreated?:(owner:string,run:Row)=>void;
 constructor(readonly db:Store,readonly execute:Executor,readonly capacity=2){}
 create(owner:string,input:unknown,key:string){
  const parsed=executeSchema.parse(input);if(!key||key.length>200)throw Error('A request identifier is required');
  for(const id of parsed.context.attachments)if(!this.db.get(owner,'artifact',id))throw Error('Attachment not found');
  const agent=this.db.list(owner,'agent')[0];
  if(parsed.context.agentId&&parsed.context.agentId!==agent?.id)throw Error('Employee not found');
  if(parsed.context.conversationId&&!this.db.get(owner,'conversation',parsed.context.conversationId))throw Error('Conversation not found');
  const hash=createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
  let created:Row|undefined;
  const result=this.db.transaction(()=>{
   const prior=this.db.sql.prepare('SELECT hash,id FROM dedupe WHERE owner=? AND key=?').get(owner,key);
   if(prior){if(prior.hash!==hash)throw Error('Request identifier already used for different work');return this.db.get(owner,'run',String(prior.id))!;}
   const conversationId=parsed.context.conversationId??this.db.create(owner,'conversation',{title:(parsed.title??parsed.task).slice(0,80)}).id;
   const run=this.db.create(owner,'run',{...parsed,context:{...parsed.context,conversationId},agentId:agent?.id,conversationId,status:'queued'});
   this.db.create(owner,'message',{conversationId,runId:run.id,role:'user',text:run.task});
   this.db.sql.prepare('INSERT INTO dedupe VALUES(?,?,?,?)').run(owner,key,hash,run.id);
   for(const id of parsed.context.attachments)this.db.create(owner,'evidence_link',{runId:run.id,artifactId:id});
   this.db.event(owner,'run.updated',{runId:run.id,status:'queued'});created=run;return run;
  });
  if(created)try{this.onCreated?.(owner,created);}catch{}
  return result;
 }
 state(owner:string,id:string,status:string,extra:object={}){const run=this.db.get(owner,'run',id);if(!run||terminal.has(run.status))return;this.db.put(owner,'run',{...run,...extra,status});this.db.event(owner,'run.updated',{runId:id,status});}
 cancel(owner:string,id:string){if(!this.db.get(owner,'run',id))throw Error('Task not found');this.state(owner,id,'cancelled',{completedAt:new Date().toISOString()});this.active.get(id)?.abort();for(const a of this.db.list(owner,'approval',-1).filter(a=>a.runId===id&&a.status==='pending'))this.db.put(owner,'approval',{...a,status:'denied'});}
 recover(){for(const {owner,data} of this.db.all('run'))if(!terminal.has(data.status)&&data.status!=='queued')this.state(owner,data.id,'needs_user',{recovered:true,error:'The server restarted. Review recorded actions, then resume. Uncertain actions are never repeated automatically.'});}
 resume(owner:string,id:string){
  const run=this.db.get(owner,'run',id);if(!run||!run.recovered||this.active.has(id)||terminal.has(run.status))throw Error('This task cannot be resumed');
  if(this.db.list(owner,'action',-1).some(a=>a.runId===id&&['executing','uncertain'].includes(a.status)))throw Error('An external action needs reconciliation before this task can resume');
  this.state(owner,id,'queued',{recovered:false,error:null});
 }
 async tick(){const jobs:Promise<void>[]=[];
  for(const {owner,data:run} of this.db.all('run')){
   if(this.active.size>=this.capacity)break;
   if(run.status!=='queued'||this.active.has(run.id)||this.db.list(owner,'run',-1).some(r=>this.active.has(r.id)))continue;
   const c=new AbortController();this.active.set(run.id,c);this.state(owner,run.id,'working',{startedAt:run.startedAt??new Date().toISOString()});
   jobs.push((async()=>{try{
    const answer=await this.execute(owner,this.db.get(owner,'run',run.id)!,c.signal);if(c.signal.aborted||!this.db.get(owner,'run',run.id))return;
    if(!answer.result?.trim())throw Error('Employee returned no result');
    this.db.transaction(()=>{this.state(owner,run.id,'verifying');this.db.create(owner,'artifact',{runId:run.id,kind:'document',name:'Task result',text:answer.result});this.db.create(owner,'message',{runId:run.id,conversationId:run.conversationId,role:'assistant',text:answer.result});this.state(owner,run.id,'completed',{result:answer.result,usage:answer.usage,completedAt:new Date().toISOString()});});
   }catch(e){if(!c.signal.aborted)this.state(owner,run.id,'failed',{error:e instanceof Error?e.message:'Unable to finish task',completedAt:new Date().toISOString()});}finally{this.active.delete(run.id);}})());
  }await Promise.all(jobs);
 }
 stop(){for(const c of this.active.values())c.abort();}
}
