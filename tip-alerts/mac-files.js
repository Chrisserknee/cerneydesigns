(()=>{'use strict';
// Mac files: browse designated Mac story folders, preview, download originals, and upload originals with context.
// Bytes go phone <-> Mac through the Mac's encrypted tunnel; the cloud only issues a 10-minute ticket.
const $=id=>document.getElementById(id);
const E=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const size=n=>n>=1073741824?(n/1073741824).toFixed(2)+' GB':n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
const when=iso=>new Date(iso).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const hex=buf=>Array.from(new Uint8Array(buf)).map(x=>x.toString(16).padStart(2,'0')).join('');
const sha=async bytes=>hex(await crypto.subtle.digest('SHA-256',bytes));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ICONS={folder:'📁',video:'🎬',image:'🖼️',audio:'🎙️',document:'📄'};
const PARALLEL=2,WEB_DOWNLOAD_MAX=1024**3;
let conn=null,roots=[],rootID=null,folder=null,uploading=0,db=null;
const rows=[];

function message(text,error=false){$('notice').textContent=text;$('notice').className=error?'error':'';}
function button(text,fn,cls){const b=E('button',text,cls);b.type='button';b.addEventListener('click',fn);return b;}
function nativeState(){window.webkit?.messageHandlers?.producerState?.postMessage({dirty:uploading>0});}

// ---- Access: a short ticket from the signed-in Cerney Tips session ----
async function ticket(force=false){
 if(!force&&conn&&Date.parse(conn.expiresAt)-Date.now()>60000)return conn;
 const r=await fetch('/api/tip-alerts',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'producer-mac-ticket'}),cache:'no-store'});
 const body=await r.json().catch(()=>({}));
 if(r.status===401)throw Object.assign(Error('Sign in to Cerney Tips, then reopen Mac files.'),{fatal:true});
 if(!r.ok)throw Error(body.error||'Couldn’t reach Cerney Tips. Try again.');
 if(!body.configured)throw Object.assign(Error('Mac files isn’t connected yet. Finish the Mac setup steps.'),{fatal:true});
 conn=body;return conn;
}
// One request to the Mac. Refreshes an expired ticket once, waits when the Mac says it's busy.
async function mac(method,path,{json,raw,headers={},timeout=60000,retries=3}={}){
 for(let attempt=0;;attempt++){
  const c=await ticket(attempt>0&&attempt===1);
  let r;
  try{r=await fetch(c.url+path,{method,headers:{Authorization:'Bearer '+c.ticket,...(json?{'Content-Type':'application/json'}:{}),...headers},body:json?JSON.stringify(json):raw,cache:'no-store',signal:AbortSignal.timeout(timeout)});}
  catch{if(attempt<retries){await sleep(1500*(attempt+1));continue;}throw Object.assign(Error('Your Mac isn’t reachable right now. It may be offline or asleep.'),{offline:true});}
  if(r.status===401&&attempt===0){conn=null;continue;}
  if((r.status===429||r.status===503&&!/drive/.test(r.statusText))&&attempt<retries){await sleep(Number(r.headers.get('Retry-After')||2)*1000);continue;}
  if(!r.ok&&r.status!==202){const b=await r.json().catch(()=>({}));const e=Object.assign(Error(b.error||'The Mac couldn’t do that.'),{status:r.status,deviceCode:b.deviceCode});throw e;}
  return r;
 }
}
const macJSON=async(method,path,json)=>(await mac(method,path,{json})).json();
function explain(e){if(e.deviceCode)return `This phone needs approval on the Mac. On the Mac, run:\nmac-transfer approve ${e.deviceCode}`;return e.message;}

// ---- Browse ----
async function loadStatus(){
 const s=await macJSON('GET','/v1/status');roots=s.roots;
 const tabs=$('rootTabs');tabs.replaceChildren();
 for(const r of roots){const b=button(r.label+(r.state==='ok'?'':r.state==='unmounted'?' · drive not connected':' · unavailable'),()=>open({root:r.id}));b.setAttribute('aria-current',r.id===rootID?'true':'false');tabs.append(b);}
 const w=roots.find(r=>r.writable);$('macState').textContent=w?.state==='ok'?'● Mac connected · '+size(w.freeBytes)+' free':w?.state==='unmounted'?'Mac connected · project drive not connected':'● Mac connected';
}
async function open(target){
 try{
  const r=await macJSON('POST','/v1/list',target);folder=r.folder;rootID=r.folder.root;
  for(const b of $('rootTabs').children)b.setAttribute('aria-current',String(roots.find(x=>x.label&&b.textContent.startsWith(x.label))?.id===rootID));
  const crumbs=$('crumbs');crumbs.replaceChildren();r.folder.crumbs.forEach((c,i)=>{if(i)crumbs.append(E('span','›'));crumbs.append(i===r.folder.crumbs.length-1?E('strong',c.name):button(c.name,()=>open({folder:c.id})));});
  $('uploadBox').hidden=!r.folder.canUpload;$('newStory').hidden=!r.folder.canCreateStory;
  // iPhone Uploads takes files directly; story folders put them in "Phone Uploads".
  document.querySelector('#uploadBox .lead').textContent=r.folder.flat?'Upload to your Mac':'Add to this story';
  document.querySelector('#drop .drop-hint').textContent=r.folder.flat?'Goes straight into iPhone Uploads on your Mac · never overwrites':'Saved in this story’s “Phone Uploads” folder · never overwrites';
  $('note').placeholder=r.folder.flat?'Note for these files (optional). Saved in “Upload Notes.md”.':'Context for these files (optional). Saved in the story’s “Story Context.md”.';
  const list=$('entries');list.replaceChildren();
  if(!r.entries.length)list.append(E('li',r.folder.canUpload?'No files yet. Upload some above.':'Nothing here yet.','empty'));
  for(const e of r.entries){const li=E('li'),b=button('',()=>e.type==='folder'?open({folder:e.id}):view(e),'entry');
   const meta=E('span',undefined,'meta');meta.append(E('span',e.name,'name'),E('small',e.type==='folder'?'Folder · '+when(e.modified):size(e.bytes)+' · '+when(e.modified)));
   b.append(E('span',ICONS[e.type==='folder'?'folder':e.kind]||'📄','icon'),meta);li.append(b);list.append(li);}
  if(r.truncated)list.append(E('li','Showing the newest 2,000 items.','empty'));
  message('');paintPaused();
 }catch(e){message(explain(e),true);}
}

// ---- View, preview, download ----
let viewerURL=null;
function closeViewer(){$('viewer').close();if(viewerURL){URL.revokeObjectURL(viewerURL);viewerURL=null;}$('viewerBody').replaceChildren();}
async function view(e){
 $('viewerName').textContent=e.name;const body=$('viewerBody'),actions=$('viewerActions');body.replaceChildren(E('p',size(e.bytes)+' · '+when(e.modified)));actions.replaceChildren();
 if(!$('viewer').open)$('viewer').showModal();
 actions.append(button('Download original · '+size(e.bytes),ev=>download(e,ev.currentTarget)));
 if(['image','video','audio'].includes(e.kind)){
  const p=E('p','Preparing a preview on the Mac…');body.append(p);
  try{for(let i=0;i<200;i++){const r=await mac('GET','/v1/previews/'+e.id,{timeout:120000});if(r.status===202){await sleep(3000);continue;}
    const blob=await r.blob();if(!$('viewer').open)return;viewerURL=URL.createObjectURL(blob);
    const el=e.kind==='image'?E('img'):E(e.kind);el.src=viewerURL;if(e.kind!=='image'){el.controls=true;el.playsInline=true;}else el.alt='Preview of '+e.name;
    p.replaceWith(el);if(e.kind==='video')body.append(E('p','Preview is a lighter copy of the first two minutes. The original is untouched.'));return;}
   p.textContent='The preview is taking a while. You can still download the original.';
  }catch(err){p.textContent=explain(err);}
 }
}
async function download(e,b){
 try{const c=await ticket();
  // In the app, the iPhone downloads straight to storage (resumable), then offers the share sheet.
  const native=window.webkit?.messageHandlers?.macDownload;
  if(native){native.postMessage({url:c.url+'/v1/files/'+e.id,ticket:c.ticket,filename:e.name,bytes:e.bytes});b.textContent='Downloading in the app…';b.disabled=true;return;}
  if(e.bytes>WEB_DOWNLOAD_MAX){message('Files over 1 GB download through the Cerney Tips app.',true);return;}
  b.disabled=true;const parts=[],step=8*1024*1024;
  for(let o=0;o<e.bytes;o+=step){const r=await mac('GET','/v1/files/'+e.id,{headers:{Range:`bytes=${o}-${Math.min(e.bytes,o+step)-1}`},timeout:180000});if(r.status!==206&&!(r.status===200&&e.bytes<=step))throw Error('The Mac sent an unexpected response. Try again.');parts.push(await r.arrayBuffer());b.textContent='Downloading '+Math.floor(Math.min(1,(o+step)/e.bytes)*100)+'%';}
  const url=URL.createObjectURL(new Blob(parts,{type:e.mime}));const a=E('a','Save '+e.name,'download');a.href=url;a.download=e.name;b.replaceWith(a);
 }catch(err){message(explain(err),true);b.disabled=false;}
}

// ---- Upload: resumable 4 MB chunks, each checksummed; the Mac verifies the whole file before "Done" ----
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('cerney-mac-transfer-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('uploads',{keyPath:'key'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function store(op,value){return new Promise((resolve,reject)=>{if(!db)return resolve(op==='all'?[]:undefined);const t=db.transaction('uploads',op==='all'?'readonly':'readwrite'),s=t.objectStore('uploads');const r=op==='all'?s.getAll():op==='put'?s.put(value):s.delete(value);t.oncomplete=()=>resolve(r.result);t.onerror=()=>reject(t.error);});}
const keyOf=(folderID,f)=>[folderID,f.name,f.size,f.lastModified].join('|');
async function paintPaused(){
 const list=(await store('all')).filter(p=>!rows.some(r=>r.key===p.key&&r.state!=='failed'));const box=$('pausedList');box.replaceChildren();$('paused').hidden=!list.length;
 for(const p of list){const li=E('li');li.append(E('div',`${p.name} · ${size(p.bytes)} · stopped at ${Math.floor((p.progress||0)*100)}%`),E('div',p.folderName?'In '+p.folderName:'','muted'));
  li.append(button('Choose it again to resume',async()=>{await open({folder:p.folder});$('files').click();},'ghost small'),button('Cancel',async()=>{try{if(p.uploadID)await mac('DELETE','/v1/uploads/'+p.uploadID);}catch{}await store('delete',p.key);paintPaused();},'ghost small'));box.append(li);}
}
function addFiles(list){
 if(!folder?.canUpload){message('Open a story folder first.',true);return;}
 for(const file of list){const row={file,key:keyOf(folder.id,file),folder:folder.id,folderName:folder.crumbs.at(-1)?.name,note:$('note').value.trim(),state:'waiting',el:E('li')};
  if(!rows.some(r=>r.key===row.key&&['waiting','uploading'].includes(r.state))){rows.push(row);$('uploads').append(row.el);draw(row);}}
 pump();
}
function draw(row){
 const head=E('div',undefined,'name');head.append(E('span',row.file.name),E('span',size(row.file.size),'muted'));const parts=[head];
 if(['waiting','uploading','verifying'].includes(row.state)){const bar=E('progress');bar.max=1;bar.value=row.progress||0;parts.push(bar,E('div',row.state==='waiting'?'Waiting…':row.state==='verifying'?'Mac is verifying the file…':'Uploading '+Math.floor((row.progress||0)*100)+'%','muted'));}
 if(row.state==='done')parts.push(E('div',`Saved on the Mac as “${row.result.name}” · verified`,'muted'));
 if(row.state==='failed'){parts.push(E('div',row.error,'failed'));if(row.retryable)parts.push(button('Resume',()=>{row.state='waiting';draw(row);pump();},'ghost small'));}
 row.el.replaceChildren(...parts);
}
let pumping=false;
async function pump(){if(pumping)return;pumping=true;
 try{for(let row;(row=rows.find(r=>r.state==='waiting'));){uploading++;nativeState();row.state='uploading';draw(row);
  try{await upload(row);row.state='done';await store('delete',row.key);}
  catch(e){row.state='failed';row.error=explain(e)+(e.status===413||e.status===415?'':' Progress is kept on the Mac.');row.retryable=![413,415,400].includes(e.status);}
  finally{uploading--;nativeState();draw(row);}}}
 finally{pumping=false;paintPaused();if(folder)open({folder:folder.id});}
}
async function upload(row){
 const f=row.file;
 const u=await macJSON('POST','/v1/uploads',{folder:row.folder,name:f.name,bytes:f.size,lastModified:f.lastModified,note:row.note});
 if(u.state==='complete'){row.result=u.file;row.progress=1;return;}
 const pending={key:row.key,folder:row.folder,folderName:row.folderName,name:f.name,bytes:f.size,uploadID:u.id,progress:u.received.length/u.chunks};await store('put',pending);
 const have=new Set(u.received),hashes=new Array(u.chunks);let next=0,done=have.size,failed=null;
 const slice=i=>f.slice(i*u.chunkBytes,Math.min(f.size,(i+1)*u.chunkBytes)).arrayBuffer();
 const worker=async()=>{while(!failed&&next<u.chunks){const i=next++;try{
   const bytes=await slice(i),h=await sha(bytes);hashes[i]=h;
   if(!have.has(i)){await mac('PUT',`/v1/uploads/${u.id}/chunks/${i}`,{raw:bytes,headers:{'Content-Type':'application/octet-stream','X-Chunk-SHA256':h},timeout:180000,retries:5});done++;}
   row.progress=done/u.chunks;draw(row);pending.progress=row.progress;store('put',pending).catch(()=>{});
  }catch(e){failed=failed||e;}}};
 await Promise.all(Array.from({length:PARALLEL},worker));if(failed)throw failed;
 row.state='verifying';draw(row);
 const manifest=await sha(new TextEncoder().encode(hashes.join('')));
 const r=await macJSON('POST',`/v1/uploads/${u.id}/finish`,{manifest});row.result=r.file;row.progress=1;
}

// ---- Start ----
async function start(){
 try{db=await openDB();}catch{}
 try{await ticket();await loadStatus();const first=roots.find(r=>r.writable&&r.state==='ok')||roots.find(r=>r.state==='ok');if(first)await open({root:first.id});else message('Your Mac’s project drive isn’t connected right now.',true);}
 catch(e){$('macState').textContent=e.offline?'Mac offline':'Not connected';message(explain(e),true);paintPaused();}
}
$('files').addEventListener('change',()=>{addFiles([...$('files').files]);$('files').value='';});
const drop=$('drop');drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over');});drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
drop.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('over');addFiles([...e.dataTransfer.files]);});
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
$('createStory').addEventListener('click',async()=>{const name=$('storyName').value.trim();if(!name)return;try{const r=await macJSON('POST','/v1/folders',{root:rootID,name});$('storyName').value='';await open({folder:r.id});message('Story folder created.');}catch(e){message(explain(e),true);}});
$('closeViewer').addEventListener('click',closeViewer);$('viewer').addEventListener('close',()=>{if(viewerURL){URL.revokeObjectURL(viewerURL);viewerURL=null;}});
window.addEventListener('beforeunload',e=>{if(uploading>0){e.preventDefault();e.returnValue='';}});
// Native app tells us how a download ended.
window.macDownloadFinished=(ok,text)=>message(text,!ok);
start();
})();
