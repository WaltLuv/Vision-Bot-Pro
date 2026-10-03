import {test} from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../src/employee/db.js';import {ToolGateway} from '../src/employee/tools.js';
import {assertPublicUrl,htmlToText,isPrivateAddress,registerWeb,searchProvider} from '../src/employee/web.js';

const reply=(body:string,init:ResponseInit&{url?:string}={})=>{const r=new Response(body,{headers:{'content-type':'text/html'},...init});if(init.url)Object.defineProperty(r,'url',{value:init.url});return r;};
function gateway(http:typeof fetch){const db=new Store(':memory:'),t=new ToolGateway(db);registerWeb(t,http);db.put('a','run',{id:'r',status:'working'});return {db,t};}

// The model picks these URLs after reading pages it does not control, so this is
// an outbound request an attacker can aim. It matters most here because the
// gateway shares a machine with Hermes and whatever else is on that VM.
test('only the public internet is reachable',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.5','172.16.0.1','172.31.255.255','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','fd00::1','fe80::1'])
  assert.equal(isPrivateAddress(ip),true,`${ip} must be refused`);
 for(const ip of ['8.8.8.8','1.1.1.1','93.184.216.34','172.15.0.1','172.32.0.1','2606:4700::1111'])
  assert.equal(isPrivateAddress(ip),false,`${ip} is ordinary internet`);
});

test('an address that is not an ordinary web page is refused',async()=>{
 await assert.rejects(()=>assertPublicUrl('http://127.0.0.1:8788/api/state'),/not on the public internet/);
 await assert.rejects(()=>assertPublicUrl('http://[::1]/'),/not on the public internet/);
 // The cloud metadata endpoint is the classic way to steal a machine's credentials.
 await assert.rejects(()=>assertPublicUrl('http://169.254.169.254/latest/meta-data/'),/not on the public internet/);
 await assert.rejects(()=>assertPublicUrl('file:///etc/passwd'),/Only web addresses/);
 await assert.rejects(()=>assertPublicUrl('ftp://example.com/x'),/Only web addresses/);
 await assert.rejects(()=>assertPublicUrl('http://user:secret@example.com/'),/carries credentials/);
 await assert.rejects(()=>assertPublicUrl('not a url'),/not a valid web address/);
});

test('a redirect cannot land somewhere private after a public start',async()=>{
 const {db,t}=gateway(async()=>reply('<p>inside</p>',{url:'http://127.0.0.1:9/secrets'}));
 await assert.rejects(()=>t.invoke('a','r','web_read',{url:'https://example.com'},'k'),/not on the public internet/);
 db.close();
});

test('a page is returned as readable text, without its scripts or markup',()=>{
 const text=htmlToText('<html><head><title>T</title><style>.a{color:red}</style></head><body><script>steal()</script><h1>Roof</h1><p>Two tiles are cracked.</p><p>Ladder &amp; harness needed.</p></body></html>');
 assert.ok(!/steal\(\)|color:red|<p>/.test(text),`markup survived: ${text}`);
 assert.match(text,/Roof/);assert.match(text,/Two tiles are cracked\./);
 assert.match(text,/Ladder & harness needed\./,'entities are decoded');
});

test('reading a page returns its address, title and text',async()=>{
 const {db,t}=gateway(async()=>reply('<title>Weather</title><body><p>18C and raining</p>',{url:'https://example.com/w'}));
 const r=await t.invoke('a','r','web_read',{url:'https://example.com/w'},'k');
 assert.equal(r.title,'Weather');
 assert.match(r.text,/18C and raining/);
 assert.equal(r.truncated,false);
 assert.equal(r.url,'https://example.com/w');
 db.close();
});

test('a very long page is cut rather than returned whole, and says it was cut',async()=>{
 const {db,t}=gateway(async()=>reply('<body>'+'word '.repeat(60_000)));
 const r=await t.invoke('a','r','web_read',{url:'https://example.com'},'k');
 assert.equal(r.text.length,100_000);
 assert.equal(r.truncated,true,'the employee is told the page was cut, so it does not treat it as complete');
 db.close();
});

test('a page that is too large to hold is refused outright',async()=>{
 const {db,t}=gateway(async()=>reply('x'.repeat(2_000_001)));
 await assert.rejects(()=>t.invoke('a','r','web_read',{url:'https://example.com'},'k'),/too large/);
 db.close();
});

test('a page that did not load is an error, not empty text',async()=>{
 const {db,t}=gateway(async()=>reply('nope',{status:404}));
 await assert.rejects(()=>t.invoke('a','r','web_read',{url:'https://example.com'},'k'),/HTTP 404/);
 db.close();
});

test('json is returned as it came, not mangled into prose',async()=>{
 const {db,t}=gateway(async()=>new Response('{"temp_f":61,"desc":"Light rain"}',{headers:{'content-type':'application/json'}}));
 const r=await t.invoke('a','r','web_read',{url:'https://example.com/api'},'k');
 assert.deepEqual(JSON.parse(r.text),{temp_f:61,desc:'Light rain'});
 db.close();
});

/** Runs with exactly these search settings, whatever the environment had. */
async function withEnv(env:Record<string,string|undefined>,body:()=>Promise<void>){
 const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
 for(const [k,v] of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;
 try{await body();}finally{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}
}
const NO_SEARCH={SEARCH_API_KEY:undefined,GEMINI_API_KEY:undefined,GOOGLE_API_KEY:undefined,SEARCH_MODEL:undefined};

test('search says it is not connected rather than inventing results',async()=>{
 await withEnv(NO_SEARCH,async()=>{
  const {db,t}=gateway(async()=>{throw Error('must not be called');});
  await assert.rejects(()=>t.invoke('a','r','web_search',{query:'anything'},'k'),/not connected/);
  assert.equal(searchProvider(),null);
  db.close();
 });
});

// Gemini's generateContent with Google Search on, as the API answers it: the answer, what it searched for, the pages
// (as Google redirect links, titled with their site) and which part of the answer each page backs.
const GEMINI_KEY='fixture-gemini-key-0123456789abcdef';
const redirect=(id:string)=>`https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
const grounded=(text:string,chunks:{id:string;title:string}[],supports:{text:string;chunks:number[]}[],queries=['moen 1222 cartridge replacement'])=>({
 candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP',groundingMetadata:{webSearchQueries:queries,searchEntryPoint:{renderedContent:'<div class="container">…</div>'},
  groundingChunks:chunks.map(c=>({web:{uri:redirect(c.id),title:c.title}})),
  groundingSupports:supports.map(s=>({segment:{startIndex:text.indexOf(s.text),endIndex:text.indexOf(s.text)+s.text.length,text:s.text},groundingChunkIndices:s.chunks}))}}],
 usageMetadata:{promptTokenCount:40,candidatesTokenCount:60,totalTokenCount:100}});
/** Gemini plus Google's redirect host. Every request is recorded; anything else is refused. */
function geminiStandIn(answer:(body:any,n:number)=>{status?:number;body:any},landings:Record<string,string|null>){
 const calls:{url:string;init:any;body?:any}[]=[];let n=0;
 const http=(async(input:any,init:any={})=>{const url=String(input);
  if(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/')){const body=JSON.parse(init.body);calls.push({url,init,body});const r=answer(body,n++);return new Response(JSON.stringify(r.body),{status:r.status??200,headers:{'content-type':'application/json'}});}
  if(url.startsWith('https://vertexaisearch.cloud.google.com/')){calls.push({url,init});assert.equal(init.redirect,'manual','a grounding link is followed one hop, never into the page');const to=landings[url.split('/').pop()!];
   if(to===null)throw Error('redirect host unreachable');return new Response(null,{status:302,headers:{location:to??'https://example.com/'}});}
  throw Error(`unexpected request to ${url}`);}) as typeof fetch;
 return {http,calls};
}

test('without a search API key, a Gemini key searches Google, and each result is the page behind the answer',async()=>{
 await withEnv({...NO_SEARCH,GEMINI_API_KEY:GEMINI_KEY},async()=>{
  const text='The Moen 1222 Posi-Temp cartridge fits most single-handle Moen shower valves. The Home Depot lists it at $28.98.';
  const {http,calls}=geminiStandIn(()=>({body:grounded(text,[{id:'aaa',title:'moen.com'},{id:'bbb',title:'homedepot.com'},{id:'ccc',title:'moen.com'}],
   [{text:'The Moen 1222 Posi-Temp cartridge fits most single-handle Moen shower valves.',chunks:[0,2]},{text:'The Home Depot lists it at $28.98.',chunks:[1]}])}),
   {aaa:'https://www.moen.com/products/1222',bbb:'https://www.homedepot.com/p/Moen-Posi-Temp-Cartridge-1222/100153536',ccc:'https://www.moen.com/products/1222'});
  assert.equal(searchProvider(),'gemini');
  const {db,t}=gateway(http);
  const r=await t.invoke('a','r','web_search',{query:'Moen 1222 cartridge'},'k');
  assert.equal(r.provider,'Google Search, through Gemini');
  assert.equal(r.answer,text);assert.deepEqual(r.searches,['moen 1222 cartridge replacement']);
  assert.deepEqual(r.results.map((x:any)=>x.url),['https://www.moen.com/products/1222','https://www.homedepot.com/p/Moen-Posi-Temp-Cartridge-1222/100153536'],'the pages themselves, once each, not Google redirect links');
  assert.equal(r.results[1].title,'homedepot.com');assert.equal(r.results[1].snippet,'The Home Depot lists it at $28.98.','each page comes with the part of the answer it backs');
  // The request: the owner's key in a header (never the address), Google Search on, and the model told to stick to the pages.
  const ask=calls[0]!;assert.match(ask.url,/models\/gemini-3\.5-flash:generateContent$/);assert.equal(ask.init.headers['x-goog-api-key'],GEMINI_KEY);assert.ok(!ask.url.includes(GEMINI_KEY));
  assert.deepEqual(ask.body.tools,[{google_search:{}}]);assert.match(ask.body.contents[0].parts[0].text,/Moen 1222 cartridge[\s\S]*Do not add anything the pages do not say/);
  assert.equal(ask.body.generationConfig.thinkingConfig.thinkingLevel,'low');
  assert.equal(calls.filter(c=>c.url.startsWith('https://vertexaisearch')).length,3,'only Google\'s redirect host is asked, and no page is loaded');
  db.close();
 });
});

test('a Gemini search that fails says why in plain words, and never repeats the key',async()=>{
 const cases:[number,string,RegExp][]=[
  [402,'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.',/out of credits.*Top it up in Google AI Studio.*SEARCH_API_KEY/],
  [400,`API key not valid. Please pass a valid API key. (${GEMINI_KEY})`,/did not accept its API key/],
  [429,'Resource has been exhausted (e.g. check quota).',/rate limit or quota/],
  [404,'models/gemini-3.5-flash is not found for API version v1beta',/no model called gemini-3\.5-flash.*SEARCH_MODEL/],
  [500,`Internal error encountered for key ${GEMINI_KEY}`,/HTTP 500: Internal error encountered for key \[redacted\]/],
 ];
 for(const [status,message,expected] of cases)await withEnv({...NO_SEARCH,GOOGLE_API_KEY:GEMINI_KEY},async()=>{
  const {http}=geminiStandIn(()=>({status,body:{error:{code:status,message,status:'X'}}}),{});
  const {db,t}=gateway(http);
  const error=await t.invoke('a','r','web_search',{query:'anything'},'k').then(()=>null,(e:Error)=>e);
  assert.ok(error,`HTTP ${status} must fail`);assert.match(error!.message,expected);assert.ok(!error!.message.includes(GEMINI_KEY),'the key is never repeated');
  db.close();
 });
});

test('a model that takes no thinking level is asked again without one; an older model is never sent one',async()=>{
 await withEnv({...NO_SEARCH,GEMINI_API_KEY:GEMINI_KEY},async()=>{
  const {http,calls}=geminiStandIn((body,n)=>n===0?{status:400,body:{error:{code:400,message:'Thinking level is not supported for this model.',status:'INVALID_ARGUMENT'}}}:{body:grounded('An answer.',[],[])},{});
  const {db,t}=gateway(http);
  assert.equal((await t.invoke('a','r','web_search',{query:'anything'},'k')).answer,'An answer.');
  assert.equal(calls.length,2);assert.ok(calls[0]!.body.generationConfig);assert.equal(calls[1]!.body.generationConfig,undefined);
  db.close();
 });
 await withEnv({...NO_SEARCH,GEMINI_API_KEY:GEMINI_KEY,SEARCH_MODEL:'gemini-2.5-flash'},async()=>{
  const {http,calls}=geminiStandIn(()=>({body:grounded('An answer.',[],[])}),{});
  const {db,t}=gateway(http);
  await t.invoke('a','r','web_search',{query:'anything'},'k');
  assert.match(calls[0]!.url,/gemini-2\.5-flash:generateContent$/);assert.equal(calls[0]!.body.generationConfig,undefined);
  db.close();
 });
});

test('a grounding link that cannot be followed is kept as it is, and a search API key still wins over Gemini',async()=>{
 await withEnv({...NO_SEARCH,GEMINI_API_KEY:GEMINI_KEY},async()=>{
  const {http}=geminiStandIn(()=>({body:grounded('Fact.',[{id:'gone',title:'lowes.com'}],[{text:'Fact.',chunks:[0]}])}),{gone:null});
  const {db,t}=gateway(http);
  const r=await t.invoke('a','r','web_search',{query:'anything'},'k');
  assert.deepEqual(r.results.map((x:any)=>[x.url,x.title]),[[redirect('gone'),'lowes.com']]);
  db.close();
 });
 await withEnv({...NO_SEARCH,GEMINI_API_KEY:GEMINI_KEY,SEARCH_API_KEY:'fixture-only'},async()=>{
  assert.equal(searchProvider(),'api');
  const {db,t}=gateway(async(input:any)=>{assert.match(String(input),/api\.search\.brave\.com/);return new Response(JSON.stringify({web:{results:[{title:'A',url:'https://a.test',description:'one'}]}}),{headers:{'content-type':'application/json'}});});
  assert.equal((await t.invoke('a','r','web_search',{query:'anything'},'k')).provider,'api.search.brave.com');
  db.close();
 });
});

test('search results normalize across provider shapes',async()=>{
 const saved=process.env.SEARCH_API_KEY;process.env.SEARCH_API_KEY='fixture-only';
 try{
  for(const body of [
   {web:{results:[{title:'A',url:'https://a.test',description:'one'}]}},
   {results:[{title:'A',url:'https://a.test',content:'one'}]},
   {organic_results:[{title:'A',link:'https://a.test',snippet:'one'}]},
  ]){
   const {db,t}=gateway(async()=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}}));
   const r=await t.invoke('a','r','web_search',{query:'roof repair'},'k');
   assert.deepEqual(r.results.map((x:any)=>x.url),['https://a.test']);
   assert.equal(r.results[0].title,'A');
   db.close();
  }
 }finally{if(saved===undefined)delete process.env.SEARCH_API_KEY;else process.env.SEARCH_API_KEY=saved;}
});

test('reading the web needs no approval, but is recorded as an action',async()=>{
 const {db,t}=gateway(async()=>reply('<body>hello'));
 const r=await t.invoke('a','r','web_read',{url:'https://example.com'},'k');
 assert.ok(!r.approvalId,'reading a public page is not a decision for a person');
 assert.equal(db.list('a','action').find(x=>x.name==='web_read')?.status,'completed');
 db.close();
});
