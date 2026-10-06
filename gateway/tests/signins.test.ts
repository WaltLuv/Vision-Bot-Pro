import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {spawn,type ChildProcess} from 'node:child_process';import {mkdtempSync,rmSync,existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {saveSignins,loadSignins,forgetSignins,signinStatus,type Cookie} from '../src/employee/signins.js';

const env=(vars:Record<string,string|undefined>)=>{const saved=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));for(const [k,v] of Object.entries(vars))if(v===undefined)delete process.env[k];else process.env[k]=v;return ()=>{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;};};
const cookie=(domain:string,name='session',expires=-1):Cookie=>({name,value:`secret-${domain}-value`,domain,path:'/',expires,httpOnly:true,secure:true,sameSite:'Lax'});

test('the vault keeps only retailer sign-ins, encrypted on the volume, and nothing at all without a key',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-vault-'));const restore=env({EMPLOYEE_DATA_DIR:dir,SIGNIN_VAULT_KEY:'k'.repeat(40),STATE_SECRET:undefined,SIGNIN_DOMAINS:undefined});
 try{
  const r=saveSignins('alice',[cookie('.homedepot.com'),cookie('www.lowes.com'),cookie('.example.com'),cookie('.homedepot.com','old',1)]);
  assert.equal(r.saved,2,'Home Depot and Lowe\'s only; another site\'s cookie and an expired one are dropped');
  const files=readdirSync(path.join(dir,'signins'));assert.equal(files.length,1);assert.ok(!files[0]!.includes('alice'),'the file name does not name the owner');
  const raw=readFileSync(path.join(dir,'signins',files[0]!));assert.ok(!raw.toString('latin1').includes('secret-'),'no cookie value is readable on disk');
  assert.deepEqual(loadSignins('alice').cookies.map(c=>c.domain).sort(),['.homedepot.com','www.lowes.com']);
  assert.deepEqual(loadSignins('bob').cookies,[],'one owner never gets another\'s');
  assert.deepEqual(signinStatus('alice').saved.sort(),['homedepot.com','lowes.com']);assert.ok(!JSON.stringify(signinStatus('alice')).includes('secret-'));
  raw[raw.length-1]^=1;writeFileSync(path.join(dir,'signins',files[0]!),raw);assert.deepEqual(loadSignins('alice').cookies,[],'a tampered file is refused, not half-read');
  saveSignins('alice',[cookie('.homedepot.com')]);forgetSignins('alice');assert.deepEqual(loadSignins('alice').cookies,[]);
  const restore2=env({SIGNIN_VAULT_KEY:undefined});try{assert.equal(saveSignins('alice',[cookie('.homedepot.com')]).saved,0,'no key, nothing saved');}finally{restore2();}
 }finally{restore();rmSync(dir,{recursive:true,force:true});}
});

const CHROMIUM=process.env.CHROMIUM_PATH??'/opt/pw-browsers/chromium';
const skip=existsSync(CHROMIUM)?false:'no Chromium to stand in for the remote browser (set CHROMIUM_PATH)';
function chromium(dir:string){return new Promise<{ws:string;proc:ChildProcess}>((resolve,reject)=>{const proc=spawn(CHROMIUM,['--headless=new','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${dir}`,'--no-proxy-server','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});let err='';proc.stderr!.on('data',d=>{err+=d;const m=err.match(/DevTools listening on (ws:\/\/\S+)/);if(m)resolve({ws:m[1]!,proc});});proc.on('exit',()=>reject(Error(err.slice(-300))));});}
const stop=async(proc:ChildProcess)=>{if(proc.exitCode!==null)return;const exited=new Promise(r=>proc.once('exit',r));try{process.kill(-proc.pid!,'SIGKILL');}catch{proc.kill('SIGKILL');}await exited;};

test('an account browser comes back signed in and saves what the owner did; a guest browser gets nothing',{skip,timeout:120000},async t=>{
 // Each session gets a fresh Chromium, as each Browserbase session is a fresh browser.
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-acct-'));let n=0;const remotes:ChildProcess[]=[];
 const api=createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('content-type','application/json');
  if(req.method==='POST'&&req.url==='/v1/sessions'){const r=await chromium(path.join(dir,`p${++n}`));remotes.push(r.proc);return res.end(JSON.stringify({id:`bb-${n}`,connectUrl:r.ws}));}
  if(req.url?.includes('/debug'))return res.end(JSON.stringify({debuggerFullscreenUrl:'https://www.browserbase.com/x'}));res.end('{}');});
 api.listen(0,'127.0.0.1');await new Promise(r=>api.on('listening',r));
 const restore=env({EMPLOYEE_DATA_DIR:dir,SIGNIN_VAULT_KEY:'k'.repeat(40),BROWSERBASE_API_KEY:'fixture-browserbase-key-0123456789',BROWSERBASE_API_BASE:`http://127.0.0.1:${(api.address() as any).port}`,COMPUTER_CAPACITY:'3'});
 const {Store}=await import('../src/employee/db.js'),{BrowserbaseBrowsers}=await import('../src/employee/browserbase.js'),{BrowserCapability}=await import('../src/employee/browser.js');
 const db=new Store(':memory:'),bb=new BrowserbaseBrowsers(db),computers=new BrowserCapability(db,bb);
 t.after(async()=>{db.close();api.closeAllConnections();api.close();for(const p of remotes)await stop(p);rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});restore();});
 const ctx=(runId:string)=>({owner:'alice',runId,actionId:'a',assertAuthorized:()=>{}});
 for(const id of ['r1','r2','r3'])db.put('alice','run',{id,task:'Pro pricing',status:'working'});

 const first=await bb.openFor(ctx('r1'),'Sign in to Pro Xtra',{session:'account'});
 // The owner takes over and signs in; the site sets its cookies. A cookie from another site comes along too.
 await bb.page('alice','r1')!.context().addCookies([{name:'THD_SESSION',value:'pro-xtra-signed-in',domain:'.homedepot.com',path:'/',expires:Math.floor(Date.now()/1000)+86400,httpOnly:true,secure:true,sameSite:'Lax'},{name:'tracker',value:'x',domain:'.example.com',path:'/',expires:-1,httpOnly:false,secure:false,sameSite:'Lax'}]);
 const r=db.get('alice','computer',first.computerId)!;db.put('alice','computer',{...r,control:'owner'});await computers.control('alice',first.computerId,'agent');
 assert.deepEqual(loadSignins('alice').cookies.map(c=>c.name),['THD_SESSION'],'handing back saves the retailer sign-in, and only that');
 await bb.release('alice',first.computerId,'closed');

 await bb.openFor(ctx('r2'),'Check Pro Xtra pricing',{session:'account'});
 const restored=await bb.page('alice','r2')!.context().cookies('https://www.homedepot.com');
 assert.deepEqual(restored.map(c=>c.name),['THD_SESSION'],'the next account browser comes back signed in');
 await bb.openFor(ctx('r3'),'Look up drywall prices',{session:'guest'});
 assert.deepEqual(await bb.page('alice','r3')!.context().cookies(),[],'a guest browser carries nothing of the owner\'s');
 for(const c of db.list('alice','computer'))await bb.release('alice',c.id,'closed');
});
