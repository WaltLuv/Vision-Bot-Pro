import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {spawn,type ChildProcess} from 'node:child_process';import {mkdtempSync,rmSync,existsSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/employee/db.js';import {ToolGateway} from '../src/employee/tools.js';import {BrowserCapability} from '../src/employee/browser.js';import {BrowserbaseBrowsers} from '../src/employee/browserbase.js';

/**
 * The employee driving a Browserbase browser itself. Only Browserbase's REST
 * API is a stand-in (shaped like its official SDK); the browser is a real
 * Chromium reached over CDP, exactly as a Browserbase session's connectUrl is,
 * so every step -- navigate, read, type, click, screenshot -- really happens
 * on a real page of a small local shop site.
 */
const CHROMIUM=process.env.CHROMIUM_PATH??'/opt/pw-browsers/chromium';
const skip=existsSync(CHROMIUM)?false:'no Chromium to stand in for the remote browser (set CHROMIUM_PATH)';
const KEY='fixture-browserbase-key-0123456789';
const LIVE='https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com/debug/bb-1';

function shop(){
 const orders:string[]=[];
 const page=(title:string,body:string)=>`<!doctype html><title>${title}</title><body>${body}</body>`;
 const server=createServer((req,res)=>{
  const url=new URL(req.url??'/','http://shop');res.setHeader('content-type','text/html');
  if(url.pathname==='/')return res.end(page('Hardware shop','<form action="/search"><label>Search <input name="q"></label></form><a href="/product">Product</a>'));
  if(url.pathname==='/search')return res.end(page('Results',`<p>Results for ${String(url.searchParams.get('q')).replace(/[<>&]/g,'')}</p><a href="/product">Moen 1222 cartridge</a>`));
  if(url.pathname==='/product')return res.end(page('Moen 1222 cartridge','<h1>Moen 1222 cartridge</h1><p>$28.98 - 3 in stock</p><form method="post" action="/cart"><button>Add to cart</button></form><form method="post" action="/order"><button>Confirm and pay</button><input type="submit" value="Place order"></form><a href="/signin">Sign in</a>'));
  if(url.pathname==='/cart')return res.end(page('Cart','<p>1 item in your cart</p>'));
  // A hidden label, a button and a link all say "Search": the button is what "Search" means.
  if(url.pathname==='/find')return res.end(page('Find','<form action="/search"><label for="q" style="display:none">Search products</label><input id="q" name="q" placeholder="Search products"><button>Search</button></form><a href="/cart">Search tips</a>'));
  if(url.pathname==='/order'){orders.push(req.method!);return res.end(page('Ordered','<p>Order placed</p>'));}
  if(url.pathname==='/signin')return res.end(page('Sign in','<label>Email <input type="email" name="email"></label><label>Password <input type="password" name="pw"></label><label>Access word <input type="password" name="aw"></label><label>Name on order <input name="cardholder" autocomplete="cc-name"></label><label>Delivery note <input name="note"></label>'));
  res.statusCode=404;res.end();
 });
 server.listen(0,'127.0.0.1');
 return new Promise<{url:string;orders:string[];close():void}>(r=>server.on('listening',()=>r({url:`http://127.0.0.1:${(server.address() as any).port}`,orders,close:()=>{server.closeAllConnections();server.close();}})));
}

/** A real Chromium with a CDP endpoint, standing in for the remote browser. */
function chromium(dir:string){
 return new Promise<{ws:string;proc:ChildProcess}>((resolve,reject)=>{
  // A process group of its own, so stopping it stops its helper processes too, before they can write to the profile again.
  const proc=spawn(CHROMIUM,['--headless=new','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${dir}`,'--no-proxy-server','--disable-breakpad','--disable-crash-reporter','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});
  let err='';proc.stderr!.on('data',d=>{err+=d;const m=err.match(/DevTools listening on (ws:\/\/\S+)/);if(m)resolve({ws:m[1]!,proc});});
  proc.on('exit',()=>reject(Error('Chromium exited: '+err.slice(-300))));
 });
}

/** Browserbase's REST API, shaped like the official SDK: create, live view, release. */
function browserbaseApi(connectUrl:string){
 const seen={keys:new Set<string>(),created:[] as any[],released:[] as any[],debug:[] as string[]};
 const server=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};seen.keys.add(String(req.headers['x-bb-api-key']));
  const json=(v:unknown)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v));};
  if(req.method==='POST'&&req.url==='/v1/sessions'){seen.created.push(body);return json({id:`bb-${seen.created.length}`,status:'RUNNING',connectUrl,seleniumRemoteUrl:'',signingKey:'signing-key-not-a-secret',keepAlive:false});}
  const m=req.url?.match(/^\/v1\/sessions\/([^/?]+)(\/debug)?/);if(!m){res.statusCode=404;return res.end('{}');}
  if(m[2]){seen.debug.push(req.url!);return json({debuggerFullscreenUrl:LIVE,debuggerUrl:LIVE,wsUrl:'wss://connect.browserbase.com/debug',pages:[]});}
  if(req.method==='POST'){seen.released.push({id:m[1],...body});return json({id:m[1],status:'COMPLETED'});}
  json({id:m[1],status:'RUNNING'});
 });
 server.listen(0,'127.0.0.1');
 return new Promise<typeof seen&{url:string;close():void}>(r=>server.on('listening',()=>r({...seen,url:`http://127.0.0.1:${(server.address() as any).port}`,close:()=>{server.closeAllConnections();server.close();}})));
}

// Its profile can only be removed once it has exited; its helper processes may still be letting go of files, so the removal retries briefly.
const stopChromium=async(proc:ChildProcess)=>{if(proc.exitCode!==null||proc.signalCode!==null)return;const exited=new Promise(r=>proc.once('exit',r));try{process.kill(-proc.pid!,'SIGKILL');}catch{proc.kill('SIGKILL');}await exited;};
const waitFor=async(check:()=>boolean,what:string,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,20));}throw Error(`Timed out waiting for ${what}`);};

test('the employee drives a Browserbase browser step by step, and never spends or types a secret',{skip,timeout:120000},async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-bb-')),site=await shop(),remote=await chromium(dir),api=await browserbaseApi(remote.ws);
 const saved={key:process.env.BROWSERBASE_API_KEY,base:process.env.BROWSERBASE_API_BASE};process.env.BROWSERBASE_API_KEY=KEY;process.env.BROWSERBASE_API_BASE=api.url;
 const db=new Store(':memory:'),tools=new ToolGateway(db),bb=new BrowserbaseBrowsers(db),computers=new BrowserCapability(db,bb);bb.register(tools);
 t.after(async()=>{db.close();site.close();api.close();await stopChromium(remote.proc);rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});for(const [k,v] of [['BROWSERBASE_API_KEY',saved.key],['BROWSERBASE_API_BASE',saved.base]] as const)if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const run=db.put('alice','run',{id:'run-1',task:'Find a Moen 1222 cartridge',status:'working'});
 let n=0;const use=(name:string,args:object={})=>tools.wait('alice',run.id,name,args,`k${++n}`,AbortSignal.timeout(60000));

 // Opening a browser asks first, with the purpose on the card.
 const opening=use('browser_open',{purpose:'Find a Moen 1222 cartridge at the hardware shop'});
 await waitFor(()=>db.list('alice','approval').some(a=>a.tool==='browser_open'),'the approval card');
 const card=db.list('alice','approval').find(a=>a.tool==='browser_open')!;
 assert.equal(card.effect,'computer');assert.match(card.details.purpose,/Moen 1222/);
 assert.equal(api.created.length,0,'no browser is started before the owner allows it');
 tools.decide('alice',card.id,'once');
 const opened=await opening;
 assert.equal(opened.status,'open');
 assert.equal(JSON.stringify(opened).includes('browserbase.com'),false,'the live link, a key to the browser, never goes to the model');
 const comp=db.get('alice','computer',opened.computerId)!;
 assert.equal(comp.status,'working');assert.equal(comp.provider,'browserbase');assert.equal(comp.providerId,'bb-1');
 assert.equal(comp.liveEmbed,LIVE,'the owner gets the live view to watch');
 assert.deepEqual([...api.keys],[KEY],'the API key is sent to Browserbase, only there');
 assert.match(api.debug[0]!,/expiresIn=3600/);

 // Real steps on a real page.
 assert.equal((await use('browser_goto',{url:site.url+'/'})).title,'Hardware shop');
 const page=await use('browser_read');
 assert.match(page.text,/Search/);assert.ok(page.controls.some((c:any)=>c.label==='Product'));
 const searched=await use('browser_type',{target:'Search',text:'moen 1222',submit:true});
 assert.match(searched.url,/\/search\?q=moen\+1222/);
 assert.equal((await use('browser_click',{target:'Moen 1222 cartridge'})).title,'Moen 1222 cartridge');
 assert.equal((await use('browser_click',{target:'Add to cart'})).title,'Cart');
 const shot=await use('browser_screenshot');
 assert.equal(db.get('alice','artifact',shot.artifactId)?.mime,'image/jpeg','a picture of the page is kept as evidence');

 // Spending is the owner's, however it is asked for.
 await use('browser_goto',{url:site.url+'/product'});
 await assert.rejects(()=>use('browser_click',{target:'Place order'}),/will not press a button that places an order/);
 await assert.rejects(()=>use('browser_click',{target:'Confirm'}),/will not press a button that places an order/,'judged by the button actually hit, not the name the model used');
 assert.deepEqual(site.orders,[],'nothing was ordered');

 // The closest visible match is what gets clicked, not the first loose match in the page.
 await use('browser_goto',{url:site.url+'/find'});
 await use('browser_type',{target:'Search products',text:'bolts'});
 assert.match((await use('browser_click',{target:'Search'})).url,/\/search\?q=bolts$/,'the Search button, not the hidden label or the Search tips link');
 // A step that never reached the page changed nothing, so it is failed, not left for the owner to check.
 await assert.rejects(()=>use('browser_click',{target:'Checkout now'}),/Nothing on the page that can be clicked matches/);
 await assert.rejects(()=>use('browser_type',{target:'Coupon code',text:'X'}),/No field on the page matches/);
 const unfinished=db.list('alice','action').filter((a:any)=>['browser_click','browser_type'].includes(a.name)&&a.status!=='completed').map((a:any)=>a.status);
 assert.equal(unfinished.length,4,'two refused purchases, a click and a field that matched nothing');
 assert.ok(unfinished.every((s:string)=>s==='failed'),`none left uncertain: ${unfinished}`);
 // A refusal is certain: nothing happened, so the owner is not asked to find out what did.

 // So are secrets.
 await use('browser_goto',{url:site.url+'/signin'});
 await assert.rejects(()=>use('browser_type',{target:'Password',text:'hunter2'}),/will not type passwords or payment details/);
 await assert.rejects(()=>use('browser_type',{target:'Access word',text:'hunter2'}),/will not type passwords or payment details/,'a password field is known by its type, whatever it is called');
 await assert.rejects(()=>use('browser_type',{target:'Name on order',text:'A Owner'}),/will not type passwords or payment details/,'payment fields are known by their autocomplete too');
 assert.match((await use('browser_type',{target:'Email',text:'owner@example.com'})).title,/Sign in/,'an ordinary field is fine');

 // While the owner has the browser, the employee's next step waits for it back.
 await computers.control('alice',comp.id,'owner');
 let read=false;const waiting=use('browser_read').then(r=>{read=true;return r;});
 await new Promise(r=>setTimeout(r,700));
 assert.equal(read,false,'the step waits while you drive');
 await computers.control('alice',comp.id,'agent');
 assert.equal((await waiting).title,'Sign in');

 // Another owner cannot reach this browser.
 db.put('bob','run',{id:'run-b',task:'x',status:'working'});
 await assert.rejects(()=>tools.wait('bob','run-b','browser_read',{},'kb',AbortSignal.timeout(5000)),/No browser is open/);

 // Stop ends the session at Browserbase and drops the live link.
 await computers.cancel('alice',comp.id);
 assert.deepEqual(api.released,[{id:'bb-1',status:'REQUEST_RELEASE'}]);
 const stopped=db.get('alice','computer',comp.id)!;
 assert.equal(stopped.status,'cancelled');assert.equal(stopped.liveUrl,undefined);assert.equal(stopped.liveEmbed,undefined);
 await assert.rejects(()=>use('browser_read'),/No browser is open|closed/);

 const everything=JSON.stringify([...db.list('alice','artifact'),...db.list('alice','action'),...db.events('alice')]);
 assert.equal(everything.includes(KEY),false,'the API key is in no receipt, action or event');
});

test('a finished task keeps its browser open briefly to watch, then releases it, and nothing opens without a key',{skip,timeout:120000},async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-bb-')),remote=await chromium(dir),api=await browserbaseApi(remote.ws);
 const saved={key:process.env.BROWSERBASE_API_KEY,base:process.env.BROWSERBASE_API_BASE};process.env.BROWSERBASE_API_KEY=KEY;process.env.BROWSERBASE_API_BASE=api.url;
 const db=new Store(':memory:'),tools=new ToolGateway(db),bb=new BrowserbaseBrowsers(db),computers=new BrowserCapability(db,bb);bb.register(tools);
 t.after(async()=>{db.close();api.close();await stopChromium(remote.proc);rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});for(const [k,v] of [['BROWSERBASE_API_KEY',saved.key],['BROWSERBASE_API_BASE',saved.base]] as const)if(v===undefined)delete process.env[k];else process.env[k]=v;});
 db.put('alice','policy',{id:'p1',tool:'browser_open',policy:'allow'});
 const run=db.put('alice','run',{id:'run-2',task:'Look something up',status:'working'});
 const opened=await tools.wait('alice',run.id,'browser_open',{purpose:'Look something up'},'k1',AbortSignal.timeout(60000));
 db.put('alice','run',{...db.get('alice','run',run.id)!,status:'completed'});
 await computers.cleanup();
 assert.equal(api.released.length,0,'kept open for the owner to see where it ended');
 const lingering=db.get('alice','computer',opened.computerId)!;assert.equal(lingering.status,'working');assert.ok(lingering.lingerUntil>Date.now());
 await computers.cleanup(lingering.lingerUntil+1);
 assert.deepEqual(api.released.map(r=>r.id),['bb-1'],'and ended once the few minutes are up');
 assert.equal(db.get('alice','computer',opened.computerId)?.status,'closed');
 delete process.env.BROWSERBASE_API_KEY;
 db.put('alice','run',{id:'run-3',task:'Again',status:'working'});
 await assert.rejects(()=>tools.wait('alice','run-3','browser_open',{purpose:'Look again'},'k2',AbortSignal.timeout(10000)),/not connected/);
 assert.equal(api.created.length,1,'no session was started without a key');
});
