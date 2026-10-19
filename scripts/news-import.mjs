#!/usr/bin/env node
// Imports a reviewed local media package as a private draft. No automatic
// public publication, source-tip ingestion, or third-party URL fetching.
import {readFile,open,stat} from 'node:fs/promises';
import {resolve,dirname,basename,extname} from 'node:path';
import {createHash} from 'node:crypto';
const origin='https://www.chriscerney.org';
const agent='ChrisCerneyNewsImporter/1.0';
const manifestPath=process.argv[2];
const password=process.env.NEWS_ADMIN_PASSWORD;
if(!manifestPath||!password){console.error('Usage: NEWS_ADMIN_PASSWORD=<existing admin password> node scripts/news-import.mjs /path/to/package.json\nSet the password in your secure environment; never put it in the manifest.');process.exit(1);}
let cookie='';
async function request(path,body){const response=await fetch(origin+path,{method:'POST',redirect:'error',headers:{Origin:origin,'Content-Type':'application/json','User-Agent':agent,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const result=await response.json();if(!response.ok)throw Error(result.error||'Request failed.');if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return result;}
const mime={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.avif':'image/avif','.mp4':'video/mp4','.webm':'video/webm'};
async function upload(path,type){const file=await open(path,'r');try{const {size}=await file.stat();const session=await request('/api/news',{op:'admin-upload',name:basename(path),type,size});let offset=0,failures=0;while(offset<size){const length=Math.min(8*1024**2,size-offset);const buffer=Buffer.alloc(length);const {bytesRead}=await file.read(buffer,0,length,offset);if(bytesRead!==length)throw Error('The media file changed while reading.');let response;try{response=await fetch(session.uri,{method:'PUT',redirect:'error',headers:{Origin:origin,'Content-Type':type,'Content-Range':`bytes ${offset}-${offset+length-1}/${size}`},body:buffer,signal:AbortSignal.timeout(120000)});}catch{}if(response&&[200,201].includes(response.status))return session.id;if(response?.status===308){const match=/^bytes=0-(\d+)$/.exec(response.headers.get('range')||'');if(match&&Number(match[1])+1>offset){offset=Number(match[1])+1;failures=0;continue;}}if(++failures>5)throw Error('Upload interrupted. Re-run the import.');await new Promise(r=>setTimeout(r,Math.min(15000,1000*2**failures)));const check=await fetch(session.uri,{method:'PUT',headers:{Origin:origin,'Content-Range':`bytes */${size}`},signal:AbortSignal.timeout(30000)});if([200,201].includes(check.status))return session.id;if(check.status===308){const match=/^bytes=0-(\d+)$/.exec(check.headers.get('range')||'');offset=match?Number(match[1])+1:0;}}return session.id;}finally{await file.close();}}
try{
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 if(typeof manifest.sourceId!=='string'||!manifest.sourceId||manifest.sourceId.length>200)throw Error('Provide a stable sourceId for duplicate protection.');
 if(typeof manifest.title!=='string'||!manifest.title.trim()||manifest.title.length>180||!Array.isArray(manifest.media)||manifest.media.length>10)throw Error('Provide a headline and up to 10 media files.');
 const hex=createHash('sha256').update('chriscerney-news:'+manifest.sourceId).digest('hex');
 const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
 const files=[];for(const item of manifest.media){const path=resolve(dirname(resolve(manifestPath)),item.file);const type=mime[extname(path).toLowerCase()];if(!type)throw Error('Unsupported media extension.');await stat(path);files.push({path,type,alt:item.alt||''});}
 await request('/api/admin-auth',{password});
 const existing=(await request('/api/news',{op:'admin-list'})).posts.find(post=>post.id===id);
 if(existing){console.log('This source is already imported. Review it at '+origin+'/admin/news/');process.exit(0);}
 const media=[];for(const file of files)media.push({id:await upload(file.path,file.type),alt:file.alt});
 await request('/api/news',{op:'admin-save',id,revision:0,title:manifest.title,caption:manifest.caption||'',location:manifest.location||'',topic:manifest.topic||'',status:'draft',notify:false,media});
 console.log('Private draft saved. Review and publish at '+origin+'/admin/news/');
}catch(error){console.error(error.message);process.exitCode=1;}
