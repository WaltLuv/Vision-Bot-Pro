import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {spawn,type ChildProcess} from 'node:child_process';import {mkdtempSync,rmSync,existsSync} from 'node:fs';import os from 'node:os';import path from 'node:path';

/**
 * jev-browser driving the owner's Browserbase page through browser_do. The browser is a real Chromium; Browserbase's
 * API and TypeSafe's Jev are stand-ins. This Jev is deliberately careless: it picks whichever element the goal names
 * and never thinks anything is irreversible, so what stops a purchase, a password or an upload here is the gateway.
 */
const CHROMIUM=process.env.CHROMIUM_PATH??'/opt/pw-browsers/chromium';
const skip=existsSync(CHROMIUM)?false:'no Chromium to stand in for the remote browser (set CHROMIUM_PATH)';

function listen(handler:Parameters<typeof createServer>[1]){const server=createServer(handler);server.listen(0,'127.0.0.1');return new Promise<{url:string;close():void}>(r=>server.on('listening',()=>r({url:`http://127.0.0.1:${(server.address() as any).port}`,close:()=>{server.closeAllConnections();server.close();}})));}
const page=(title:string,body:string)=>`<!doctype html><title>${title}</title><body>${body}</body>`;
function shop(){const orders:string[]=[];return listen((req,res)=>{res.setHeader('content-type','text/html');const u=new URL(req.url??'/','http://x');
 if(u.pathname==='/')return res.end(page('Drywall',`<h1>Drywall 1/2 in. 4x8</h1><p>$14.98</p><p id="cart">Cart: ${u.searchParams.get('added')??0}</p><form action="/"><input type="hidden" name="added" value="1"><button>Add to cart</button></form><form method="post" action="/order"><button>Confirm and pay</button></form><label>Password <input type="password" name="pw"></label><label>Note <input name="note"></label><input type="file" aria-label="Photo">`));
 if(u.pathname==='/order'){orders.push('order');return res.end(page('Ordered','Order placed'));}
 res.statusCode=404;res.end();}).then(s=>({...s,orders}));}
/** Jev, careless: the element whose label the goal quotes, clicked; done once something was done. */
function careless(){const asked:any[]=[];return listen(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);asked.push(body);
 const goal=String(body.state?.task?.goal??''),history=body.state?.task?.history??[],els=body.state?.page?.elements??[],want=goal.match(/"([^"]+)"/)?.[1]?.toLowerCase()??'';
 const acted=history.some((h:any)=>h.action);const pick=els.find((e:any)=>String(e.text??e.label??'').toLowerCase()===want)??els[0];
 const tool=acted?'none':/^type/i.test(goal)?'type':/^upload/i.test(goal)?'upload':'click';
 const answers:any={};for(const [k,q] of Object.entries<any>(body.questions)){
  if(q.type==='noul')answers[k]={type:'noul',noul:['done','done_change','complete'].includes(k)?(acted?0.97:0.03):0.02};
  else if(k==='tool')answers[k]={type:'choice',choice:tool,probabilities:{[tool]:0.95},confidence:0.95};
  else if(k==='target'){const i=String(pick?.i??0);answers[k]={type:'choice',choice:i,probabilities:{[i]:0.95},confidence:0.95};}
  else{const c=Object.keys(q.criteria??{})[0];answers[k]={type:'choice',choice:c,probabilities:{[c]:0.95},confidence:0.95};}
 }
 res.setHeader('content-type','application/json');res.end(JSON.stringify({answers,usage:{input_tokens:10}}));}).then(s=>({...s,asked}));}
function chromium(dir:string){return new Promise<{ws:string;proc:ChildProcess}>((resolve,reject)=>{const proc=spawn(CHROMIUM,['--headless=new','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${dir}`,'--no-proxy-server','about:blank'],{stdio:['ignore','ignore','pipe'],detached:true});let err='';proc.stderr!.on('data',d=>{err+=d;const m=err.match(/DevTools listening on (ws:\/\/\S+)/);if(m)resolve({ws:m[1]!,proc});});proc.on('exit',()=>reject(Error(err.slice(-300))));});}
const bbApi=(connectUrl:string)=>listen(async(req,res)=>{for await(const _ of req){}res.setHeader('content-type','application/json');
 if(req.method==='POST'&&req.url==='/v1/sessions')return res.end(JSON.stringify({id:'bb-1',connectUrl}));
 if(req.url?.includes('/debug'))return res.end(JSON.stringify({debuggerFullscreenUrl:'https://www.browserbase.com/devtools-fullscreen/x'}));res.end('{}');});
const stop=async(proc:ChildProcess)=>{if(proc.exitCode!==null)return;const exited=new Promise(r=>proc.once('exit',r));try{process.kill(-proc.pid!,'SIGKILL');}catch{proc.kill('SIGKILL');}await exited;};

test('browser_do: Jev decides each step on the watched page, and the gateway still refuses to pay, type secrets or upload',{skip,timeout:120000},async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'vc-jev-')),site=await shop(),jev=await careless(),remote=await chromium(dir),api=await bbApi(remote.ws);
 const saved=Object.fromEntries(['BROWSERBASE_API_KEY','BROWSERBASE_API_BASE','TYPESAFE_API_KEY','JEV_API_URL'].map(k=>[k,process.env[k]]));
 Object.assign(process.env,{BROWSERBASE_API_KEY:'fixture-browserbase-key-0123456789',BROWSERBASE_API_BASE:api.url,TYPESAFE_API_KEY:'ts_fixture_key_0123456789',JEV_API_URL:`${jev.url}/v1/systemone`});
 // jev-browser reads its address when it loads, so it is loaded after the stand-in is set.
 const {Store}=await import('../src/employee/db.js'),{ToolGateway}=await import('../src/employee/tools.js'),{BrowserbaseBrowsers}=await import('../src/employee/browserbase.js');
 const db=new Store(':memory:'),tools=new ToolGateway(db),bb=new BrowserbaseBrowsers(db);bb.register(tools);
 t.after(async()=>{for(const c of db.list('alice','computer'))await bb.release('alice',c.id,'closed').catch(()=>{});db.close();site.close();jev.close();api.close();await stop(remote.proc);rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 db.put('alice','policy',{id:'p1',tool:'browser_open',policy:'allow'});db.put('alice','run',{id:'r1',task:'Drywall',status:'working'});
 let n=0;const use=(name:string,args:object={})=>tools.wait('alice','r1',name,args,`k${++n}`,AbortSignal.timeout(60000));
 assert.ok(tools.tools.has('browser_do'),'offered when a TypeSafe key is set');
 await use('browser_open',{purpose:'Drywall'});await use('browser_goto',{url:site.url+'/'});

 const added=await use('browser_do',{goal:'Click "Add to cart"'});
 assert.equal(added.status,'done');assert.match(added.url,/added=1/,'Jev clicked the button the goal named, on the real page');
 assert.ok(jev.asked.every(b=>b.model==='jev-latest'),'every decision went to Jev');

 const paid=await use('browser_do',{goal:'Click "Confirm and pay"'});
 assert.equal(paid.status,'refused');assert.match(paid.info,/will not press a button that places an order or pays/);assert.equal(site.orders.length,0,'nothing was bought, though Jev saw no risk');

 const secret=await use('browser_do',{goal:'Type the note into "Password"',values:{note:'hunter2-hunter2'}});
 assert.equal(secret.status,'refused');assert.match(secret.info,/passwords or payment details/);
 await assert.rejects(use('browser_do',{goal:'Type it into "Note"',values:{password:'hunter2'}}),/passwords or payment details/,'a secret-looking value is refused before the page is touched');
 await assert.rejects(use('browser_do',{goal:'Type it into "Note"',values:{note:'4111 1111 1111 1111'}}),/passwords or payment details/);

 const up=await use('browser_do',{goal:'Upload to "Photo"',values:{file:'/etc/passwd'}});
 assert.equal(up.status,'refused');assert.match(up.info,/will not upload files/);
 assert.equal(db.list('alice','action').filter(a=>a.name==='browser_do').length,6,'each call is on the record');
});
