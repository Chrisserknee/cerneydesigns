'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sourcePattern=/^tips\/(?:submit-story_)?\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z0-9]{12}\/_submission\.json$/;
async function main(){
 const input=JSON.parse(fs.readFileSync(0,'utf8')),cfg=JSON.parse(fs.readFileSync(input.config,'utf8'));
 const auth=require(path.join(cfg.firebase_tools,'lib/auth.js')),account=auth.getGlobalDefaultAccount();
 const token=await auth.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);
 const base=`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o`;
 async function request(url,options={}){
  const response=await fetch(url,{...options,headers:{Authorization:`Bearer ${token.access_token}`,...options.headers},signal:AbortSignal.timeout(30000)});
  if(!response.ok && ![404,412].includes(response.status))throw Error('STORAGE_FAILED');return response;
 }
 const saved=[];
 for(const item of input.items){
  if(item.version!==1 || !sourcePattern.test(item.source) || crypto.createHash('sha256').update(item.source).digest('hex')!==item.id || !/^\d+$/.test(item.sourceGeneration) || JSON.stringify(item).length>4096)throw Error('INVALID_RECORD');
  const source=await request(`${base}/${encodeURIComponent(item.source)}?fields=generation`);
  if(source.status===404 || String((await source.json()).generation)!==item.sourceGeneration)continue;
  const name='_tipalerts/v1/enrichment/'+item.id+'.json',url=base+'/'+encodeURIComponent(name);
  const current=await request(url+'?fields=generation');let generation='0';
  if(current.status!==404){
   generation=String((await current.json()).generation);
   const body=await request(url+'?alt=media&generation='+generation);
   if(body.status===404)continue;
   const old=await body.json();
   if(Date.parse(old.updatedAt)>Date.parse(item.updatedAt))continue;
  }
  // Multipart upload sets no-store atomically along with the private JSON body.
  const boundary='inbox-'+crypto.randomBytes(12).toString('hex');
  const body=`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({name,contentType:'application/json',cacheControl:'no-store'})}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(item)}\r\n--${boundary}--`;
  const result=await request(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(cfg.bucket)}/o?uploadType=multipart&ifGenerationMatch=${generation}`,{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});
  if(result.status!==412)saved.push(item.id);
 }
 return {saved};
}
main().then(r=>process.stdout.write(JSON.stringify(r))).catch(()=>{process.stdout.write(JSON.stringify({error:'INBOX_SYNC_FAILED'}));process.exitCode=1;});
