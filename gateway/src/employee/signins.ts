import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';import {mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,renameSync,chmodSync} from 'node:fs';import path from 'node:path';import {dataDir} from './config.js';
/**
 * Saved sign-ins: the cookies of an owner's own retailer accounts (Home Depot Pro Xtra, Lowe's Pro volume pricing),
 * kept on this server's data volume (/data on Fly) so an authenticated browser comes back signed in.
 *
 * The owner signs in themselves, in a browser they have taken over; the employee never types a password. When that
 * browser closes, or is handed back, its cookies for the allowed retailer domains (SIGNIN_DOMAINS) are encrypted
 * with AES-256-GCM under a key derived from SIGNIN_VAULT_KEY (or STATE_SECRET) and written to one file per owner.
 * Cookies for any other site are dropped, so a guest search never leaks into, or out of, the vault. Without a key
 * nothing is saved. "Forget saved sign-ins" deletes the file.
 */
export interface Cookie{name:string;value:string;domain:string;path:string;expires:number;httpOnly:boolean;secure:boolean;sameSite:'Strict'|'Lax'|'None'}
export const signinDomains=()=>(process.env.SIGNIN_DOMAINS??'homedepot.com,lowes.com').split(',').map(d=>d.trim().toLowerCase().replace(/^\./,'')).filter(Boolean);
const vaultSecret=()=>process.env.SIGNIN_VAULT_KEY??process.env.STATE_SECRET??'';
export const signinsEnabled=()=>vaultSecret().length>=32;
const key=()=>createHash('sha256').update('visionbot-signin-vault:'+vaultSecret()).digest();
const file=(owner:string)=>path.join(dataDir(),'signins',createHash('sha256').update('signins:'+owner).digest('hex')+'.json.enc');
const allowed=(c:Cookie,domains=signinDomains())=>{const d=c.domain.toLowerCase().replace(/^\./,'');return domains.some(x=>d===x||d.endsWith('.'+x));};

export function saveSignins(owner:string,cookies:Cookie[],now=Date.now()){
 if(!signinsEnabled())return {saved:0};
 const keep=cookies.filter(c=>allowed(c)&&(c.expires===-1||c.expires*1000>now));
 if(!keep.length)return {saved:0};
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);
 const body=Buffer.concat([cipher.update(JSON.stringify({savedAt:new Date(now).toISOString(),cookies:keep})),cipher.final()]);
 const target=file(owner),tmp=target+'.tmp';mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
 writeFileSync(tmp,Buffer.concat([iv,cipher.getAuthTag(),body]),{mode:0o600});renameSync(tmp,target);chmodSync(target,0o600);
 return {saved:keep.length};
}
export function loadSignins(owner:string,now=Date.now()):{cookies:Cookie[];savedAt?:string}{
 const f=file(owner);if(!signinsEnabled()||!existsSync(f))return {cookies:[]};
 try{const raw=readFileSync(f),decipher=createDecipheriv('aes-256-gcm',key(),raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));
  const data=JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8'));
  // Re-filtered on the way out too: narrowing SIGNIN_DOMAINS takes effect without re-saving.
  return {savedAt:data.savedAt,cookies:(data.cookies as Cookie[]).filter(c=>allowed(c)&&(c.expires===-1||c.expires*1000>now))};
 }catch{return {cookies:[]};}
}
export function forgetSignins(owner:string){rmSync(file(owner),{force:true});}
/** What the phone may know: which retailers have a saved sign-in and when. Never a cookie. */
export function signinStatus(owner:string){const {cookies,savedAt}=loadSignins(owner);return {enabled:signinsEnabled(),domains:signinDomains(),saved:[...new Set(cookies.map(c=>signinDomains().find(d=>c.domain.replace(/^\./,'').endsWith(d))!))].filter(Boolean),savedAt:savedAt??null};}
