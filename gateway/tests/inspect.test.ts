import {test} from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {createServer} from 'node:http';import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {inspectFrame} from '../src/employee/inspect.js';

const gemini=(findings:unknown[],extra:object={})=>({candidates:[{content:{parts:[{text:JSON.stringify({findings,summary:'Checked the wall and ceiling joint.',...extra})}]}}]});
const CRACK={type:'crack',severity:'high',confidence:0.82,description:'Possible diagonal crack from the window corner',location:'upper left',box:[80,40,420,310],recommendation:'Measure the width and monitor it'};
const STAIN={type:'water_damage',severity:'low',confidence:0.6,description:'Possible old water stain',location:'ceiling',recommendation:'Check for moisture'};

test('a frame comes back as findings, worst first, and a serious structural one always says to call a professional',async()=>{
 const saved=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='gemini_fixture_key_0123456789';
 try{
  const sent:any[]=[];const http=(async(url:string,init:RequestInit)=>{sent.push({url,body:JSON.parse(String(init.body))});return new Response(JSON.stringify(gemini([STAIN,CRACK],{needsProfessional:false})));}) as typeof fetch;
  const r=await inspectFrame(Buffer.from('jpeg'),'image/jpeg','the window header',http);
  assert.deepEqual(r.findings.map(f=>f.type),['crack','water_damage']);assert.equal(r.needsProfessional,true,'enforced in code, whatever the model said');
  assert.deepEqual(r.findings[0]!.box,[80,40,420,310]);
  assert.equal(sent[0].body.generationConfig.responseMimeType,'application/json');assert.match(sent[0].body.contents[0].parts[0].text,/never a diagnosis[\s\S]*the window header/);
  const bad=(async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:'{"findings":[{"type":"alien"}]}'}]}}]}))) as unknown as typeof fetch;
  await assert.rejects(inspectFrame(Buffer.from('x'),'image/jpeg','',bad),/usable form/,'an answer outside the schema is refused, not shown');
  delete process.env.GEMINI_API_KEY;await assert.rejects(inspectFrame(Buffer.from('x'),'image/jpeg'),/needs a Gemini key/);
 }finally{if(saved===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=saved;}
});

test('HTTP: frames are inspected for the signed-in owner, kept as evidence, CSRF-checked, rate limited; LiveKit Cloud is allowed',async()=>{
 const fake=createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('content-type','application/json');res.end(JSON.stringify(gemini([CRACK])));});fake.listen(0,'127.0.0.1');await new Promise(r=>fake.on('listening',r));
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-inspect-'));
 const saved=Object.fromEntries(['GEMINI_API_KEY','GEMINI_API_BASE','EMPLOYEE_DATA_DIR','EMPLOYEE_DB_PATH','INSPECT_RATE_LIMIT','LIVEKIT_URL'].map(k=>[k,process.env[k]]));
 Object.assign(process.env,{GEMINI_API_KEY:'gemini_fixture_key_0123456789',GEMINI_API_BASE:`http://127.0.0.1:${(fake.address() as any).port}`,EMPLOYEE_DATA_DIR:dir,EMPLOYEE_DB_PATH:path.join(dir,'e.sqlite'),INSPECT_RATE_LIMIT:'3',LIVEKIT_URL:'wss://visionbot-x1y2.livekit.cloud'});
 const {installEmployee}=await import('../src/employee/routes.js'),{initStore}=await import('../src/store.js'),{tokenHash}=await import('../src/employee/auth.js'),{appContentSecurityPolicy}=await import('../src/csp.js');initStore(path.join(dir,'legacy.json'));
 const app=express();app.use(express.json());const ids=new Map([['fixture-a','alice'],['fixture-b','bob']]);
 const e=installEmployee(app,(req,token)=>ids.get(token??req.header('authorization')?.slice(7)??'')??null,(owner,hash)=>[...ids].some(([t,o])=>o===owner&&tokenHash(t)===hash),async()=>({result:'x'}));
 const server=app.listen(0);await new Promise(r=>server.on('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'fixture-a'})});const cookie=login.headers.get('set-cookie')!.split(';')[0]!,csrf=(await login.json()).csrf;
  const send=(h:Record<string,string>)=>fetch(base+'/api/inspect?focus=window%20header',{method:'POST',headers:{'content-type':'image/jpeg',...h},body:Buffer.from('jpeg-frame')});
  assert.equal((await send({cookie})).status,403,'CSRF required');
  const ok=await send({cookie,'x-csrf-token':csrf});assert.equal(ok.status,200);const r=await ok.json();
  assert.equal(r.findings[0].type,'crack');assert.equal(r.needsProfessional,true);
  assert.equal(e.db.get('alice','inspection',r.inspectionId)!.source,'phone');assert.equal(e.db.get('alice','artifact',r.photoId)!.kind,'inspection_frame');
  assert.ok(e.db.events('alice').some(x=>x.type==='inspection.finding'));
  assert.equal(e.db.get('bob','inspection',r.inspectionId),undefined,'another owner sees none of it');
  assert.equal((await send({Authorization:'Bearer fixture-b'})).status,200,'a bearer client (the voice agent) can inspect too');
  assert.equal((await fetch(base+'/api/inspect',{method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'text/plain'},body:'hi'})).status,400);
  await send({cookie,'x-csrf-token':csrf});assert.equal((await send({cookie,'x-csrf-token':csrf})).status,429,'rate limited per person');
  const csp=appContentSecurityPolicy();assert.match(csp,/connect-src [^;]*https:\/\/\*\.livekit\.cloud;/);assert.doesNotMatch(csp,/wss:\/\/\*/);
 }finally{e.stop();server.close();fake.close();e.db.close();rmSync(dir,{recursive:true,force:true});for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
