import {test} from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import sharp from 'sharp';
import {installEmployee} from '../src/employee/routes.js';import {installLegacyTasks} from '../src/employee/legacy.js';import {tokenHash} from '../src/employee/auth.js';import {initStore} from '../src/store.js';
test('HTTP: cookie auth, CSRF, images, legacy delegation, persistence and tenant isolation',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-http-'));process.env.EMPLOYEE_DATA_DIR=dir;process.env.EMPLOYEE_DB_PATH=path.join(dir,'employee.sqlite');initStore(path.join(dir,'legacy.json'));
 const app=express();app.use(express.json());let revoked=false;const identities=new Map([['fixture-a','alice'],['fixture-b','bob']]);
 const resolve=(req:express.Request,token?:string)=>identities.get(token??req.header('authorization')?.slice(7)??'')??null;
 const e=installEmployee(app,resolve,(owner,hash)=>!revoked&&[...identities].some(([t,o])=>o===owner&&tokenHash(t)===hash),async(_owner,run)=>({result:`Completed: ${run.task}; ${run.context.attachments.length} image(s)`}));installLegacyTasks(app,e,resolve);
 const server=app.listen(0);await new Promise<void>(r=>server.on('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const get=(url:string,headers:Record<string,string>={})=>fetch(base+url,{headers});const post=(url:string,data:unknown,headers:Record<string,string>={})=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 try{
  assert.equal((await get('/api/state')).status,401);const login=await post('/api/auth/login',{token:'fixture-a'});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie')!,/HttpOnly/);const cookie=login.headers.get('set-cookie')!.split(';')[0],csrf=(await login.json()).csrf;const auth={cookie,'x-csrf-token':csrf};
  assert.equal((await post('/api/execute',{task:'x'},{cookie})).status,403);
  const response=await post('/api/execute',{task:'Research'}, {...auth,'idempotency-key':'request'});assert.equal(response.status,202);const run=await response.json();assert.equal((await get('/api/runs/'+run.id,{Authorization:'Bearer fixture-b'})).status,404);
  assert.equal((await post('/api/execute',{task:'Research'},{...auth,'idempotency-key':'request'})).status,202);assert.equal((await post('/api/execute',{task:'Changed'},{...auth,'idempotency-key':'request'})).status,409);
  const file=await fetch(base+'/api/artifacts',{method:'POST',headers:{...auth,'Content-Type':'application/octet-stream','x-file-name':'note.txt','x-file-type':'text/plain'},body:'Private evidence'});assert.equal(file.status,201);const artifact=await file.json();assert.equal(artifact.path,undefined);assert.equal((await get('/api/artifacts/'+artifact.id+'/content',{Authorization:'Bearer fixture-b'})).status,404);assert.equal(await (await get('/api/artifacts/'+artifact.id+'/content',auth)).text(),'Private evidence');
  const bad=await fetch(base+'/api/artifacts',{method:'POST',headers:{...auth,'Content-Type':'application/octet-stream'},body:'<script>bad</script>'});assert.equal(bad.status,409);
  const jpeg=await sharp({create:{width:8,height:8,channels:3,background:'#123456'}}).jpeg().toBuffer();const body={messages:[{role:'user',content:'Find this part'}],image:jpeg.toString('base64'),source:'glasses'};
  const delegated=await post('/v1/chat/completions',body,{Authorization:'Bearer fixture-a','idempotency-key':'visual'});assert.equal(delegated.status,200);const envelope=await delegated.json();assert.ok(envelope.runId);const result=await (await get('/api/runs/'+envelope.runId,auth)).json();assert.equal(result.context.source,'glasses');assert.equal(result.context.attachments.length,1);assert.match(result.result,/1 image/);
  assert.equal((await post('/v1/chat/completions',body,{Authorization:'Bearer fixture-a','idempotency-key':'visual'})).status,200);assert.equal(e.db.list('alice','run').length,2);
  // A new stream starts at now and says where that is; replaying the history made a phone refetch once per past event.
  const stream=async(url:string,until:RegExp)=>{const ac=new AbortController();const res=await fetch(base+url,{headers:auth,signal:ac.signal});const reader=res.body!.getReader();let text='';for(let i=0;i<4&&!until.test(text);i++)text+=new TextDecoder().decode((await reader.read()).value);ac.abort();return text;};
  const fresh=await stream('/api/events',/keepalive/);assert.match(fresh,/"type":"stream.ready"/);assert.doesNotMatch(fresh,/run.updated/,'no history on a new stream');
  assert.match(fresh,new RegExp(`id: ${e.db.latestEvent('alice')}\\n`),'it starts at the latest event');
  assert.match(await stream('/api/events?after=0',/run.updated/),/run.updated/,'a reconnect resumes from where it was');
  // Structured evidence, such as a call's outcome, reads as text a person can follow, not escaped JSON.
  const outcome=e.db.create('alice','artifact',{kind:'call_summary',name:'Call outcome',data:{summary:'Dan confirmed Tuesday.',transcript:'Agent: Hi\nUser: Yes',outcome:{confirmed:true}}});
  const shown=await get(`/api/artifacts/${outcome.id}/content`,auth);assert.equal(shown.status,200);assert.match(shown.headers.get('content-type')!,/^text\/plain/);assert.match(shown.headers.get('content-security-policy')!,/sandbox/);
  assert.equal(await shown.text(),'Call outcome\n\nSummary: Dan confirmed Tuesday.\n\nTranscript\n  Agent: Hi\n  User: Yes\n\nOutcome\n  Confirmed: yes\n');
  revoked=true;assert.equal((await get('/api/state',{cookie})).status,401);
 }finally{e.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));e.db.close();rmSync(dir,{recursive:true});delete process.env.EMPLOYEE_DB_PATH;delete process.env.EMPLOYEE_DATA_DIR;}
});
