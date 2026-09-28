import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export type Row = {id:string;[key:string]:any};
export class Store {
 readonly sql:DatabaseSync;
 constructor(file:string){
  if(file!==':memory:')mkdirSync(dirname(file),{recursive:true,mode:0o700});
  this.sql=new DatabaseSync(file);
  this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS records(owner TEXT NOT NULL,kind TEXT NOT NULL,id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS owner_kind ON records(owner,kind);
   CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS owner_events ON events(owner,seq);
   CREATE TABLE IF NOT EXISTS dedupe(owner TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(owner,key));
   CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,owner TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL,grant_hash TEXT NOT NULL);
   PRAGMA user_version=1;`);
  if(file!==':memory:')chmodSync(file,0o600);
 }
 put(owner:string,kind:string,value:Row):Row{
  const prior=this.sql.prepare('SELECT owner,kind FROM records WHERE id=?').get(value.id);
  if(prior&&(prior.owner!==owner||prior.kind!==kind))throw Error('Record ownership conflict');
  const data={...value,updatedAt:new Date().toISOString()};
  this.sql.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(owner,kind,data.id,JSON.stringify(data));return data;
 }
 create(owner:string,kind:string,data:object){return this.put(owner,kind,{...data,id:randomUUID(),createdAt:new Date().toISOString()});}
 get(owner:string,kind:string,id:string):Row|undefined{const r=this.sql.prepare('SELECT data FROM records WHERE owner=? AND kind=? AND id=?').get(owner,kind,id);return r?JSON.parse(String(r.data)):undefined;}
 list(owner:string,kind:string,limit=1000):Row[]{return this.sql.prepare('SELECT data FROM records WHERE owner=? AND kind=? ORDER BY rowid DESC LIMIT ?').all(owner,kind,limit).map(r=>JSON.parse(String(r.data)));}
 all(kind:string):{owner:string,data:Row}[]{return this.sql.prepare('SELECT owner,data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r=>({owner:String(r.owner),data:JSON.parse(String(r.data))}));}
 remove(owner:string,kind:string,id:string){this.sql.prepare('DELETE FROM records WHERE owner=? AND kind=? AND id=?').run(owner,kind,id);}
 event(owner:string,type:string,data:object){this.sql.prepare('INSERT INTO events(owner,data) VALUES(?,?)').run(owner,JSON.stringify({type,...data,at:new Date().toISOString()}));}
 latestEvent(owner:string){return Number((this.sql.prepare('SELECT MAX(seq) AS seq FROM events WHERE owner=?').get(owner) as any)?.seq??0);}
 events(owner:string,after=0){return this.sql.prepare('SELECT seq,data FROM events WHERE owner=? AND seq>? ORDER BY seq LIMIT 200').all(owner,after).map(r=>({seq:Number(r.seq),...JSON.parse(String(r.data))}));}
 transaction<T>(fn:()=>T){this.sql.exec('BEGIN IMMEDIATE');try{const v=fn();this.sql.exec('COMMIT');return v;}catch(e){this.sql.exec('ROLLBACK');throw e;}}
 close(){this.sql.close();}
}
