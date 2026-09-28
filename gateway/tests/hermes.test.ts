import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtempSync,rmSync} from 'node:fs';import path from 'node:path';import os from 'node:os';import {z} from 'zod';
import {Store} from '../src/employee/db.js';import {ToolGateway} from '../src/employee/tools.js';import {HermesProvider} from '../src/employee/provider.js';
test('installed Hermes process calls only governed tools and returns their result (model HTTP fixture)',{skip:!process.env.HERMES_CHECKOUT,timeout:60000},async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-hermes-'));process.env.EMPLOYEE_DATA_DIR=dir;process.env.HERMES_API_KEY='fixture-only';process.env.HERMES_PROVIDER='custom';process.env.HERMES_MODEL='fixture-model';const db=new Store(':memory:'),tools=new ToolGateway(db);let calls=0,toolCalls=0;
 tools.register({id:'fixture_lookup',description:'Look up verified fixture evidence',effect:'read',schema:z.object({query:z.string()}),run:async(a,c)=>{assert.equal(c.owner,'alice');assert.equal(a.query,'part');toolCalls++;return {evidence:'stock:3'};}});
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body||'{}');res.setHeader('Content-Type','application/json');if(req.url?.endsWith('/models')){res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}calls++;
  const found=input.messages?.some((m:any)=>m.role==='tool');
  if(!req.url?.endsWith('/chat/completions')){res.statusCode=404;res.end('{}');return;}
  assert.deepEqual(input.tools?.map((t:any)=>t.function.name),['fixture_lookup']);
  const message=found?{role:'assistant',content:'Verified stock:3'}:{role:'assistant',content:null,tool_calls:[{index:0,id:'lookup-1',type:'function',function:{name:'fixture_lookup',arguments:'{"query":"part"}'}}]};
  if(input.stream){res.setHeader('Content-Type','text/event-stream');res.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta:message,finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta:{},finish_reason:found?'stop':'tool_calls'}]})}\n\ndata: [DONE]\n\n`);return;}
  res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture-model',choices:[{index:0,message,finish_reason:found?'stop':'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
 });server.listen(0);await new Promise<void>(r=>server.on('listening',r));process.env.HERMES_BASE_URL=`http://127.0.0.1:${(server.address() as any).port}/v1`;
 const run=db.put('alice','run',{id:'r',task:'Look up the part using fixture_lookup',context:{attachments:[]},status:'working'});db.put('alice','agent',{id:'agent',skills:[]});
 try{const result=await new HermesProvider(db,tools).run('alice',run,AbortSignal.timeout(45000));assert.equal(result.result,'Verified stock:3');assert.equal(toolCalls,1);assert.ok(calls>=2);assert.equal(db.list('alice','artifact').length,1);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();rmSync(dir,{recursive:true});for(const k of ['HERMES_BASE_URL','HERMES_API_KEY','HERMES_PROVIDER','HERMES_MODEL','EMPLOYEE_DATA_DIR'])delete process.env[k];}
});

// Hermes ships tools of its own named browser_type, browser_click and web_search.
// Registered under those names, the gateway's were refused by Hermes' registry
// (a log line, not an error), so a model on Hermes was never offered them and
// could not type or click in its browser or search the web.
test('gateway tools that share a name with a Hermes built-in are offered, and run as the gateway\'s (model HTTP fixture)',{skip:!process.env.HERMES_CHECKOUT,timeout:90000},async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-hermes-'));process.env.EMPLOYEE_DATA_DIR=dir;process.env.HERMES_API_KEY='fixture-only';process.env.HERMES_PROVIDER='custom';process.env.HERMES_MODEL='fixture-model';
 const db=new Store(':memory:'),tools=new ToolGateway(db),ran:string[]=[];let offered:string[]=[];
 tools.register({id:'browser_type',description:'Type into a field',effect:'read',schema:z.object({target:z.string(),text:z.string()}),run:async a=>{ran.push(`type ${a.target}=${a.text}`);return {ok:true};}});
 tools.register({id:'browser_click',description:'Click a button',effect:'read',schema:z.object({target:z.string()}),run:async a=>{ran.push(`click ${a.target}`);return {ok:true};}});
 tools.register({id:'web_search',description:'Search the web',effect:'read',schema:z.object({query:z.string()}),run:async a=>{ran.push(`search ${a.query}`);return {results:[]};}});
 const plan=[['browser_type','{"target":"Search products","text":"Moen 1222"}'],['browser_click','{"target":"Search"}'],['web_search','{"query":"Moen 1222 price"}']];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body||'{}');res.setHeader('Content-Type','application/json');
  if(req.url?.endsWith('/models')){res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}
  if(!req.url?.endsWith('/chat/completions')){res.statusCode=404;res.end('{}');return;}
  offered=input.tools?.map((t:any)=>t.function.name)??[];
  const step=input.messages?.filter((m:any)=>m.role==='tool').length??0,next=plan[step];
  const message=next?{role:'assistant',content:null,tool_calls:[{index:0,id:`call-${step}`,type:'function',function:{name:next[0],arguments:next[1]}}]}:{role:'assistant',content:'Done'};
  const finish=next?'tool_calls':'stop';
  if(input.stream){res.setHeader('Content-Type','text/event-stream');res.end(`data: ${JSON.stringify({id:'f',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta:message,finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'f',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta:{},finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);return;}
  res.end(JSON.stringify({id:'f',object:'chat.completion',created:1,model:'fixture-model',choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
 });server.listen(0);await new Promise<void>(r=>server.on('listening',r));process.env.HERMES_BASE_URL=`http://127.0.0.1:${(server.address() as any).port}/v1`;
 const run=db.put('alice','run',{id:'r2',task:'Search the store for the Moen 1222',context:{attachments:[]},status:'working'});db.put('alice','agent',{id:'agent',skills:[]});
 try{
  const result=await new HermesProvider(db,tools).run('alice',run,AbortSignal.timeout(80000));
  assert.deepEqual([...offered].sort(),['browser_click','browser_type','web_search'],'the model is offered every gateway tool, and only those');
  assert.deepEqual(ran,['type Search products=Moen 1222','click Search','search Moen 1222 price'],'each call ran as the gateway tool, with the model\'s arguments');
  assert.equal(result.result,'Done');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();rmSync(dir,{recursive:true});for(const k of ['HERMES_BASE_URL','HERMES_API_KEY','HERMES_PROVIDER','HERMES_MODEL','EMPLOYEE_DATA_DIR'])delete process.env[k];}
});
