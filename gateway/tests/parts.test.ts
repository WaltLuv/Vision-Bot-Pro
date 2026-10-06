import {test} from 'node:test';import assert from 'node:assert/strict';
import {measures,matchSkus,aisleBay,pickRoute,registerParts,type PartSpec} from '../src/employee/parts.js';
import {Store} from '../src/employee/db.js';import {ToolGateway} from '../src/employee/tools.js';

test('measures are read in any common notation and converted to one unit',()=>{
 const len=(s:string)=>measures(s).filter(m=>m.dim==='length').map(m=>+m.value.toFixed(1));
 assert.deepEqual(len('1/2 in. x 4 ft. x 8 ft. Drywall'),[12.7,1219.2,2438.4]);
 assert.deepEqual(len('1-1/2" PVC'),[38.1]);assert.deepEqual(len('M6 x 20mm bolt'),[6,20]);assert.deepEqual(len('12.7 mm'),[12.7]);
 assert.deepEqual(measures('120V 15A 12-Gauge 20-Pack').map(m=>m.dim),['voltage','current','gauge','count']);
});

const DRYWALL:PartSpec={category:'Gypsum drywall panel',attributes:[{name:'thickness',value:'1/2 in',required:true},{name:'width',value:'4 ft',required:true},{name:'length',value:'8 ft',required:true},{name:'type',value:'moisture resistant',confidence:0.7}]};
test('SKU matching: exact, candidate or ruled out, attribute by attribute, across units',()=>{
 const r=matchSkus(DRYWALL,[
  {sku:'HD-5/8',product:'5/8 in. x 4 ft. x 8 ft. Moisture Resistant Drywall'},
  {sku:'HD-MR',product:'1/2 in. x 4 ft. x 8 ft. Moisture Resistant Drywall Panel'},
  {sku:'LW-12',product:'12.7 mm x 1219 mm x 2438 mm gypsum board'},
  {sku:'HD-10',product:'1/2 in. x 4 ft. x 10 ft. UltraLight Drywall'}]);
 assert.deepEqual(r.map(m=>[m.sku,m.quality]),[['HD-MR','exact'],['LW-12','exact'],['HD-5/8','mismatch'],['HD-10','mismatch']],'a ruled-out product still ranks by how much fits');
 assert.deepEqual(r[0]!.matched,['thickness','width','length','type']);
 assert.deepEqual(r[1]!.unknown,['type'],'metric sizes match; the unstated type is unknown, not a conflict');
 assert.deepEqual(r.find(m=>m.sku==='HD-5/8')!.conflicts,['thickness']);
 const cartridge=matchSkus({category:'Shower cartridge',attributes:[{name:'model number',value:'1222',required:true},{name:'brand',value:'Moen'}]},[{sku:'1',product:'Moen 1222 Posi-Temp Cartridge'},{sku:'2',product:'Moen 1225 Cartridge'}]);
 assert.deepEqual(cartridge.map(m=>[m.sku,m.quality]),[['1','exact'],['2','unverified']],'a part number decides, and a missing one never passes as a match');
});

test('aisle and bay are read off product pages as Home Depot and Lowe\'s print them',()=>{
 assert.deepEqual(aisleBay('In stock at Austin #6543\nAisle 23, Bay 004\nPickup today'),{aisle:'23',bay:'4'});
 assert.deepEqual(aisleBay('Aisle 45 | Bay 6'),{aisle:'45',bay:'6'});
 assert.deepEqual(aisleBay('Located in Aisle G12 Section 3'),{aisle:'G12',bay:'3'});
 assert.deepEqual(aisleBay('Located in aisle 12'),{aisle:'12'});
 assert.equal(aisleBay('Ships to home only'),null);
});

test('the pick route walks aisles in order, up one and down the next, and lists the unknowns last',()=>{
 const r=pickRoute([{name:'Screws',aisle:'14',bay:'2'},{name:'Drywall',aisle:'G2'},{name:'Mud',aisle:'14',bay:'20',quantity:2},{name:'Tape',aisle:'9',bay:'11'},{name:'Corner bead',aisle:'9',bay:'3'},{name:'Mystery part'}]);
 assert.deepEqual(r.steps.map(s=>s.name),['Corner bead','Tape','Mud','Screws','Drywall']);
 assert.match(r.text,/^1\. Aisle 9, Bay 3: Corner bead\n2\. Aisle 9, Bay 11: Tape\n3\. Aisle 14, Bay 20: 2 x Mud\n4\. Aisle 14, Bay 2: Screws\n5\. Aisle G2: Drywall\nAsk at the service desk: Mystery part$/);
});

test('the parts run end to end: photo to parameters (Gemini), offers ranked and labelled, page to aisle, pick route saved',async()=>{
 const saved=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='gemini_fixture_key_0123456789';
 const sent:any[]=[];const http=(async(url:string,init:RequestInit)=>{sent.push({url,body:JSON.parse(String(init.body)),key:new Headers(init.headers).get('x-goog-api-key')});
  return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({category:'Gypsum drywall panel',attributes:DRYWALL.attributes,searchTerms:'1/2 in drywall 4x8'})}]}}]}),{status:200});}) as typeof fetch;
 const db=new Store(':memory:'),t=new ToolGateway(db);let pageText='Drywall 1/2 in. 4 ft x 8 ft\nAisle 23, Bay 004';
 registerParts(t,db,()=>({locator:()=>({innerText:async()=>pageText}),url:()=>'https://www.homedepot.com/p/1'}) as any,http);
 try{
  db.put('a','run',{id:'r',status:'working'});
  const photo=db.create('a','artifact',{kind:'photo',name:'part.jpg',mime:'image/jpeg',base64:Buffer.from('jpeg-bytes').toString('base64')});
  const spec=await t.invoke('a','r','part_identify',{artifactId:photo.id,note:'bathroom wall patch'},'k1');
  assert.equal(spec.category,'Gypsum drywall panel');assert.equal(sent[0].key,'gemini_fixture_key_0123456789');assert.ok(!sent[0].url.includes('fixture_key'),'the key goes in a header');
  assert.equal(sent[0].body.contents[0].parts[1].inline_data.data,Buffer.from('jpeg-bytes').toString('base64'));assert.match(sent[0].body.contents[0].parts[0].text,/bathroom wall patch/);
  await assert.rejects(t.invoke('b','r','part_identify',{artifactId:photo.id},'k2'),/not active|not found/i,'another owner cannot use the photo');
  const m=db.create('a','material',{description:'drywall',quantity:4,currency:'USD',runId:'r'});
  const good=db.create('a','offer',{requestId:m.id,sku:'HD-MR',product:'1/2 in. x 4 ft. x 8 ft. Moisture Resistant Drywall',supplier:'The Home Depot',matchQuality:'unverified'});
  const bad=db.create('a','offer',{requestId:m.id,sku:'HD-5/8',product:'5/8 in. x 4 ft. x 8 ft. Drywall',supplier:'The Home Depot',matchQuality:'unverified'});
  const ranked=await t.invoke('a','r','sku_match',{spec,materialId:m.id},'k3');
  assert.equal(ranked.matches[0].sku,'HD-MR');assert.equal(db.get('a','offer',good.id)!.matchQuality,'exact');assert.deepEqual(db.get('a','offer',bad.id)!.match.conflicts,['thickness']);
  assert.deepEqual(await t.invoke('a','r','store_location',{name:'Drywall 1/2 in. 4x8',sku:'HD-MR',quantity:4},'k4'),{found:true,aisle:'23',bay:'4',itemId:db.list('a','pick_item')[0]!.id});
  pageText='Drywall screws';await t.invoke('a','r','store_location',{name:'Drywall screws'},'k5');
  await t.invoke('a','r','store_location',{name:'Joint tape',text:'Joint tape. Aisle 9, Bay 12'},'k6');
  const route=await t.invoke('a','r','store_route',{store:'Home Depot #6543'},'k7');
  assert.equal(route.text,'1. Aisle 9, Bay 12: Joint tape\n2. Aisle 23, Bay 4: 4 x Drywall 1/2 in. 4x8 (HD-MR)\nAsk at the service desk: Drywall screws');
  assert.ok(db.list('a','artifact').some(x=>x.name==='Pick route: Home Depot #6543'));
 }finally{if(saved===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=saved;db.close();}
});
