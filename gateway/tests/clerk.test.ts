import {test} from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {createServer} from 'node:http';import {generateKeyPairSync,sign} from 'node:crypto';import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {installEmployee} from '../src/employee/routes.js';import {tokenHash} from '../src/employee/auth.js';import {clerkGrantValid,frontendApiOf,ownerForEmail,clerkSettings} from '../src/employee/clerk.js';import {registerAuthRoutes} from '../src/auth.js';import {initStore} from '../src/store.js';

// Google sign-in through Clerk, end to end through the real routes: tokens are signed the way Clerk signs session tokens and
// verified by Clerk's own library (with its PEM key, networkless), and Clerk's user lookup is answered by a stand-in.
const FAPI='happy-otter-12.clerk.accounts.dev',PK='pk_test_'+Buffer.from(FAPI+'$').toString('base64');
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const b64=(v:object|Buffer)=>Buffer.from(v instanceof Buffer?v:JSON.stringify(v)).toString('base64url');
function sessionToken(sub:string,azp:string,{expiresIn=60,key=privateKey}:{expiresIn?:number;key?:typeof privateKey}={}){
 const now=Math.floor(Date.now()/1000),head=b64({alg:'RS256',typ:'JWT',kid:'ins_fixture'}),body=b64({azp,exp:now+expiresIn,iat:now,nbf:now-5,iss:`https://${FAPI}`,sid:'sess_fixture',sub});
 return `${head}.${body}.${b64(sign('RSA-SHA256',Buffer.from(`${head}.${body}`),key))}`;
}
const USERS:Record<string,{email:string;verified:boolean}>={user_owner:{email:'Walt@Example.com',verified:true},user_client:{email:'client@example.com',verified:true},user_crew:{email:'pat@crew.example',verified:true},user_stranger:{email:'stranger@example.com',verified:true},user_unverified:{email:'client@example.com',verified:false}};

test('Google sign-in through Clerk: who gets in, as whom, and only from this app',async()=>{
 // Clerk's Backend API, as much of it as a user lookup needs.
 const bapi=createServer((req,res)=>{const id=decodeURIComponent(req.url!.split('/').pop()!),u=USERS[id];
  if(!req.url!.startsWith('/v1/users/')||!u||req.headers.authorization!=='Bearer sk_test_fixture'){res.writeHead(404,{'content-type':'application/json'}).end(JSON.stringify({errors:[{code:'resource_not_found',message:'not found'}]}));return;}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({object:'user',id,primary_email_address_id:'idn_1',email_addresses:[{id:'idn_1',object:'email_address',email_address:u.email,linked_to:[],verification:{status:u.verified?'verified':'unverified',strategy:'from_oauth_google',attempts:null,expire_at:null}}]}));}).listen(0);
 await new Promise<void>(r=>bapi.on('listening',r));
 const env={CLERK_PUBLISHABLE_KEY:PK,CLERK_SECRET_KEY:'sk_test_fixture',CLERK_JWT_KEY:publicKey.export({type:'spki',format:'pem'}).toString(),CLERK_API_URL:`http://127.0.0.1:${(bapi.address() as any).port}`,
  CLERK_OWNER_EMAIL:'walt@example.com',CLERK_ALLOWED_EMAILS:'client@example.com, @crew.example',GATEWAY_TOKENS:'code-a:alice',WEB_DEMO_DIR:path.join(os.tmpdir(),`vc-no-preview-${process.pid}-${Date.now()}`)};
 const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-clerk-'));process.env.EMPLOYEE_DATA_DIR=dir;process.env.EMPLOYEE_DB_PATH=path.join(dir,'employee.sqlite');initStore(path.join(dir,'legacy.json'));
 const app=express();app.use(express.json());const tokens=new Map([['code-a','alice']]);
 const e=installEmployee(app,(req,token)=>tokens.get(token??'')??null,(owner,hash)=>[...tokens].some(([t,o])=>o===owner&&tokenHash(t)===hash)||clerkGrantValid(owner,hash),async(_o,run)=>({result:`Done: ${run.task}`}));
 registerAuthRoutes(app);
 const server=app.listen(0);await new Promise<void>(r=>server.on('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const exchange=(token:string,headers:Record<string,string>={origin:base,'x-vision-bot':'sign-in'})=>fetch(base+'/api/auth/clerk',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({token})});
 const signIn=async(sub:string)=>{const r=await exchange(sessionToken(sub,base));return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0]??'',body:await r.json()};};
 try{
  assert.equal(frontendApiOf(PK),FAPI);assert.equal(frontendApiOf('pk_test_bm90LWEtaG9zdA=='),null,'a key without the $ marker is refused');
  assert.deepEqual(await (await fetch(base+'/api/auth/options')).json(),{google:true,preview:false},'no preview built in WEB_DEMO_DIR');

  // The page: Clerk's script from this instance only, and nothing inline.
  const page=await fetch(base+'/auth/clerk');assert.equal(page.status,200);const policy=page.headers.get('content-security-policy')!,html=await page.text();
  assert.match(policy,new RegExp(`script-src 'self' https://${FAPI} https://challenges.cloudflare.com;`));assert.match(policy,new RegExp(`connect-src 'self' https://${FAPI};`));assert.doesNotMatch(policy,/unsafe-inline'[^;]*;\s*connect|script-src[^;]*unsafe-inline/);
  assert.match(html,new RegExp(`data-clerk-publishable-key="${PK}" src="https://${FAPI}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"`));assert.doesNotMatch(html,/<script>[^<]/,'no inline script');
  assert.match(await (await fetch(base+'/auth/clerk/sign-in.js')).text(),/\/api\/auth\/clerk/);
  const google=await fetch(base+'/auth/google',{redirect:'manual'});assert.equal(google.status,302);assert.equal(google.headers.get('location'),'/auth/clerk','the app\'s Google button lands on the sign-in page');

  // The owner's own Google account signs in to the owner's employee, with an ordinary session.
  const owner=await signIn('user_owner');assert.equal(owner.status,200);assert.equal(owner.body.owner,'alice');assert.match(owner.cookie,/^vc_session=/);
  const state=await fetch(base+'/api/session',{headers:{cookie:owner.cookie}});assert.equal(state.status,200);assert.equal((await state.json()).owner,'alice');
  // A listed client, and anyone at a listed domain, gets an employee of their own.
  const client=await signIn('user_client');assert.equal(client.status,200);assert.equal(client.body.owner,'client@example.com');
  assert.equal((await signIn('user_crew')).body.owner,'pat@crew.example');
  const mine=await fetch(base+'/api/execute',{method:'POST',headers:{'content-type':'application/json',cookie:client.cookie,'x-csrf-token':client.body.csrf,'idempotency-key':'k1'},body:JSON.stringify({task:'Client task'})});assert.equal(mine.status,202);
  assert.equal(e.db.list('alice','run').length,0,'a client\'s work never lands in the owner\'s employee');

  // Refused: someone not on the list, an unverified email, a token from another site, a forged or expired one, and no header.
  const stranger=await exchange(sessionToken('user_stranger',base));assert.equal(stranger.status,403);assert.match((await stranger.json()).error.message,/stranger@example\.com is not on this server's list/);
  assert.equal((await exchange(sessionToken('user_unverified',base))).status,401);
  assert.equal((await exchange(sessionToken('user_owner','https://evil.example'))).status,401,'a token issued to another site');
  assert.equal((await exchange(sessionToken('user_owner',base,{key:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey}))).status,401,'signed by someone else');
  assert.equal((await exchange(sessionToken('user_owner',base,{expiresIn:-120}))).status,401,'expired');
  assert.equal((await exchange(sessionToken('user_owner',base),{origin:base})).status,403,'not from the sign-in page');
  assert.equal((await exchange(sessionToken('user_owner',base),{'x-vision-bot':'sign-in'})).status,403,'no origin');

  // Taking an email off the list ends its sessions at the next request; the owner's stays.
  process.env.CLERK_ALLOWED_EMAILS='@crew.example';
  assert.equal((await fetch(base+'/api/state',{headers:{cookie:client.cookie}})).status,401);assert.equal((await fetch(base+'/api/state',{headers:{cookie:owner.cookie}})).status,200);
  assert.equal(ownerForEmail('pat@crew.example',clerkSettings()!,'alice'),'pat@crew.example');assert.equal(ownerForEmail('not-an-email',clerkSettings()!,'alice'),null);

  // Not set up: nothing is offered, and the routes say so instead of half-working.
  delete process.env.CLERK_SECRET_KEY;
  assert.deepEqual(await (await fetch(base+'/api/auth/options')).json(),{google:false,preview:false});assert.equal((await exchange(sessionToken('user_owner',base))).status,404);
  const off=await fetch(base+'/auth/clerk');assert.equal(off.status,404);assert.match(await off.text(),/not set up on this server/);
  assert.equal((await fetch(base+'/api/state',{headers:{cookie:owner.cookie}})).status,401,'Google sessions end when Google sign-in is turned off');
 }finally{
  e.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));bapi.close();e.db.close();rmSync(dir,{recursive:true});
  for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;delete process.env.EMPLOYEE_DB_PATH;delete process.env.EMPLOYEE_DATA_DIR;
 }
});
