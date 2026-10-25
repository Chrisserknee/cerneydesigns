(()=>{'use strict';
// Producer Desk: one context box, a large resumable picker, and a card for each finished video report.
const $=id=>document.getElementById(id);
const E=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
const statusNames={queued:'Saved in cloud · waiting for Mac',received:'Received by your Mac',working:'Claude is working',rendering:'Rendering a preview',needs_answer:'Claude has a question',ready:'Reply ready',failed:'Needs attention',cancelled:'Cancelled'};
const defaults={format:'footage',banner:'slate',length:'standard',captions:true,originalAudio:true,noMusic:true};
// Must match the backend limits in functions/producer-desk.js.
const CHUNK=2*1024*1024,MAX_FILE=2*1024*1024*1024,MAX_PARTS=1024,PARALLEL=3;
const TYPES={mp4:'video/mp4',m4v:'video/mp4',mov:'video/quicktime',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',m4a:'audio/mp4',mp3:'audio/mpeg',wav:'audio/wav',pdf:'application/pdf'};
const ALLOWED=new Set([...Object.values(TYPES),'audio/x-wav']);
const COPY_FIELDS=[['voiceover','Voiceover'],['instagramDescription','Instagram description']];
const COPY_FILES=new Set(['voiceover.txt','instagram-description.txt']);

const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
const textBytes=s=>new TextEncoder().encode(s);
const uid=()=>hash(textBytes(crypto.randomUUID()));
const encode=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const size=n=>n>=1073741824?(n/1073741824).toFixed(2)+' GB':n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';
const when=iso=>{const d=new Date(iso);return isNaN(d)?'':d.toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});};

let thread=null,id=null,refs=[],assetIDs=new Set(),pending=null,sending=false,uploading=0,authenticated=false,cursor=null,threads=[],epoch=0,loading=false,titleEdited=false,convoSignature='';
let store=null,scope=null;
const cards=new Map();      // requestID -> report card element (kept across polls so a playing preview is never replaced)
const loaded=new Map();     // artifactID -> {url,text}
const uploadRows=[];

function message(text,error=false){$('notice').textContent=text;$('notice').className=error?'error':'';}
function button(text,fn,className){const b=E('button',text,className);b.type='button';b.addEventListener('click',fn);return b;}

// ---- Device outbox: the exact unsent request survives reloads; retries reuse its IDs. ----
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('cerney-producer-outbox-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('outbox');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function local(op,value){return new Promise((resolve,reject)=>{if(!store)return reject(Error('Private retry storage is unavailable.'));const t=store.transaction('outbox',op==='get'?'readonly':'readwrite'),s=t.objectStore('outbox');let r;if(op==='get')r=s.get(scope);if(op==='put')r=s.put(value,scope);if(op==='delete')r=s.delete(scope);t.oncomplete=()=>resolve(r?.result);t.onerror=()=>reject(t.error);});}

// ---- Private API through the signed-in proxy ----
async function api(op,data={},timeout=45000){
 let response,body={};
 try{response=await fetch('/api/tip-alerts',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,...data}),cache:'no-store',signal:AbortSignal.timeout(timeout)});}
 catch{throw Object.assign(Error('The connection dropped.'),{retry:true});}
 try{body=await response.json();}catch{}
 if(response.status===401){authenticated=false;signedOut();throw Error('Sign-in required.');}
 if(!response.ok)throw Object.assign(Error(body.error||'The connection did not finish.'),{status:response.status,retry:response.status>=500||response.status===429});
 authenticated=true;return body;
}
async function retry(fn,tries=5){for(let i=0;;i++){try{return await fn();}catch(e){if(!e.retry||i>=tries-1)throw e;await new Promise(r=>setTimeout(r,800*2**i));}}}
function signedOut(){epoch++;clearStory();$('threads').replaceChildren();$('instruction').value='';message('Sign in to Cerney Tips, then reopen Producer Desk. A saved send stays queued on this device.',true);}

// ---- Style (kept, but tucked away) ----
function prefs(){return Object.fromEntries(Object.keys(defaults).map(k=>[k,typeof defaults[k]==='boolean'?$(k).checked:$(k).value]));}
function setPrefs(p=defaults){for(const k in defaults)if(typeof defaults[k]==='boolean')$(k).checked=p?.[k]??defaults[k];else $(k).value=p?.[k]||defaults[k];styleSummary();}
function styleSummary(){const pick=k=>$(k).selectedOptions[0]?.textContent||'';$('styleSummary').textContent='· '+[pick('format'),pick('banner'),pick('length')].filter(Boolean).join(' · ');}
function deriveTitle(text){const line=text.split(/\n/).find(l=>l.trim())?.trim()||'New report';const sentence=(line.match(/^.*?[.!?](?=\s|$)/)||[line])[0];if(sentence.length<=70)return sentence.replace(/[.!?]$/,'');const cut=sentence.slice(0,70);return cut.slice(0,cut.lastIndexOf(' ')>30?cut.lastIndexOf(' '):70)+'…';}
function currentTitle(){const typed=$('title').value.trim();if(typed)return typed.slice(0,180);const text=$('instruction').value.trim();return text?deriveTitle(text):'New report';}

// ---- Native container: protect unsent text and unfinished uploads ----
function dirty(){return sending||uploading>0||(!pending&&!!$('instruction').value.trim());}
function nativeState(){window.webkit?.messageHandlers?.producerState?.postMessage({dirty:dirty()});}
function controls(){
 const blocked=sending||!!pending;
 for(const k of ['instruction','title','format','banner','length','captions','originalAudio','noMusic'])$(k).disabled=blocked;
 $('files').disabled=blocked;$('drop').classList.toggle('disabled',blocked);
 $('send').disabled=sending||uploading>0;$('new').disabled=sending||uploading>0||!!pending;$('retry').disabled=sending;
 $('send').textContent=uploading>0?'Uploading files…':sending?'Sending…':pending?'Retry send':'Send to Mac';
 nativeState();
}

// ---- Attachments ----
function typeOf(file){if(ALLOWED.has(file.type))return file.type;return TYPES[(file.name.split('.').pop()||'').toLowerCase()]||'';}
function plainName(name){const clean=String(name||'attachment').replace(/[\\/\x00-\x1f]/g,'_').trim()||'attachment';if(clean.length<=180)return clean;const dot=clean.lastIndexOf('.'),ext=dot>0&&clean.length-dot<=10?clean.slice(dot):'';return clean.slice(0,180-ext.length)+ext;}
function addFiles(list){
 const files=[...list];if(!files.length)return;
 if(sending||pending){message('Send or retry your saved instruction before adding files.',true);return;}
 for(const file of files){
  const row={file,el:E('li'),state:'waiting'};
  const problem=!typeOf(file)?'Use a photo, video, audio recording or PDF.':file.size<1?'This file is empty.':file.size>MAX_FILE?'Files can be up to 2 GB. Trim or export a smaller copy.':null;
  uploadRows.push(row);$('uploads').append(row.el);
  if(problem){row.state='failed';row.error=problem;}
  drawRow(row);
 }
 pump();
}
function drawRow(row){
 const head=E('div',undefined,'name');head.append(E('span',row.file.name),E('span',size(row.file.size),'muted'));
 const parts=[head];
 if(row.state==='uploading'||row.state==='waiting'){const bar=E('progress');bar.max=1;bar.value=row.progress||0;parts.push(bar,E('div',row.state==='waiting'?'Waiting…':row.note||'Uploading…','muted'));}
 if(row.state==='failed'){parts.push(E('div',row.error,'failed'));if(typeOf(row.file)&&row.file.size<=MAX_FILE&&row.file.size>0)parts.push(button('Retry this file',()=>{row.state='waiting';row.error='';drawRow(row);pump();},'ghost small'));parts.push(button('Remove',()=>{uploadRows.splice(uploadRows.indexOf(row),1);row.el.remove();},'ghost small'));}
 row.el.replaceChildren(...parts);
}
let pumping=false;
async function pump(){
 if(pumping)return;pumping=true;
 try{for(let row;(row=uploadRows.find(r=>r.state==='waiting'));){
  uploading++;controls();row.state='uploading';drawRow(row);
  try{await upload(row);row.el.remove();uploadRows.splice(uploadRows.indexOf(row),1);}
  catch(e){row.state='failed';row.error=e.message+(e.retry===false?'':' Your progress is kept; retry resumes where it stopped.');drawRow(row);}
  finally{uploading--;controls();}
 }}finally{pumping=false;}
 if(!uploadRows.length&&thread?.assets?.length)message('Files are backed up. Add your direction and send.');
}
async function upload(row){
 const file=row.file,mimeType=typeOf(file);if(!id)id=await uid();
 const story=id,expected=epoch;
 // Deterministic per story and file, so re-selecting the same file resumes instead of starting over.
 const assetID=await hash(textBytes(['producer-asset-v2',story,file.name,file.size,file.lastModified].join(':')));
 const status=await retry(()=>api('producer-media-status',{id:story,assetID}));
 if(!status.asset){
  const total=Math.ceil(file.size/CHUNK);if(total>MAX_PARTS)throw Object.assign(Error('This file is too large.'),{retry:false});
  const have=new Set((status.parts||[]).map(p=>p.index+'-'+p.sha256)),parts=new Array(total);let next=0,done=0,failed=null;
  const worker=async()=>{while(!failed&&next<total){const i=next++;try{
   // Read one slice at a time; the whole file is never held in memory.
   const bytes=new Uint8Array(await file.slice(i*CHUNK,Math.min(file.size,(i+1)*CHUNK)).arrayBuffer()),h=await hash(bytes);
   if(!have.has(i+'-'+h))await retry(()=>api('producer-media-part',{id:story,assetID,index:i,sha256:h,base64:encode(bytes)},90000));
   if(epoch!==expected)throw Object.assign(Error('Upload stopped.'),{retry:false});
   parts[i]=h;done++;row.progress=done/total;row.note='Uploading… '+Math.floor(done/total*100)+'%';drawRow(row);
  }catch(e){failed=failed||e;}}};
  await Promise.all(Array.from({length:Math.min(PARALLEL,total)},worker));if(failed)throw failed;
  row.note='Checking upload…';drawRow(row);
  const manifest=await hash(textBytes(parts.join('')));
  const r=await retry(()=>api('producer-media-finish',{id:story,assetID,title:currentTitle(),filename:plainName(file.name),mimeType,sha256:manifest,checksumMode:'parts-v1',bytes:file.size,parts},120000));
  if(epoch===expected&&story===id&&r.thread)paint(r.thread);
 }else if(epoch===expected&&story===id&&!thread){const r=await api('producer-get',{id:story});if(r.thread)paint(r.thread);}
 if(epoch===expected&&story===id){assetIDs.add(assetID);assetPaint();}
}
function assetPaint(){
 const box=$('assets');box.replaceChildren();const list=thread?.assets||[];if(!list.length)return;
 box.append(E('div','Files Claude can use','hint'));
 for(const a of list){const row=E('div',undefined,'asset'),check=E('input'),label=E('label');check.type='checkbox';check.checked=assetIDs.has(a.id);check.addEventListener('change',()=>check.checked?assetIDs.add(a.id):assetIDs.delete(a.id));label.append(check,document.createTextNode(' '+a.filename+' · '+size(a.bytes)));row.append(label);box.append(row);}
}
function sourcePaint(){const box=$('sources');box.replaceChildren();for(const r of refs){const row=E('div',undefined,'source'),check=E('input'),label=E('label');check.type='checkbox';check.checked=true;check.addEventListener('change',()=>{refs=refs.filter(x=>x!==r);sourcePaint();});label.append(check,document.createTextNode(' '+(r.label||'Attached '+r.kind)));row.append(label);box.append(row);}}

// ---- Review files: fetched privately in verified 512 KB parts ----
async function loadArtifact(c,a,progress){
 if(loaded.has(a.id))return loaded.get(a.id);
 const expected=epoch,story=id,parts=new Array(a.parts.length);let next=0,done=0;
 const worker=async()=>{while(next<a.parts.length){const index=next++;const part=await retry(()=>api('producer-artifact',{id:story,requestID:c.id,artifactID:a.id,index}));if(epoch!==expected)throw Error('Story changed.');const bytes=decode(part.base64);if(await hash(bytes)!==a.parts[index])throw Error('Review file checksum mismatch. Try again.');parts[index]=bytes;done++;progress?.(done/a.parts.length);}};
 await Promise.all(Array.from({length:Math.min(4,a.parts.length)},worker));
 const blob=new Blob(parts,{type:a.mimeType});
 if(blob.size!==a.bytes||await hash(await blob.arrayBuffer())!==a.sha256)throw Error('Review file checksum mismatch. Try again.');
 if(epoch!==expected)throw Error('Story changed.');
 const result={url:URL.createObjectURL(blob),text:/^text\/|json$/.test(a.mimeType)?await blob.text():null};loaded.set(a.id,result);return result;
}
function downloadLink(a,url,label){const link=E('a',label||'Save '+a.filename,'download');link.href=url;link.download=a.filename;return link;}
async function copy(text,b){
 let ok=false;try{await navigator.clipboard.writeText(text);ok=true;}catch{
  const area=E('textarea',undefined,'offscreen');area.value=text;area.setAttribute('readonly','');document.body.append(area);area.select();area.setSelectionRange(0,text.length);try{ok=document.execCommand('copy');}catch{}area.remove();}
 b.textContent=ok?'Copied ✓':'Select text to copy';setTimeout(()=>{b.textContent='Copy';},1800);
}
function copyBlocks(reply){
 const blocks=[];for(const [key,label] of COPY_FIELDS){const value=reply?.[key];if(typeof value!=='string'||!value.trim())continue;
  const box=E('div',undefined,'copy'),head=E('div',undefined,'copy-head');head.append(E('h4',label),button('Copy',e=>copy(value,e.currentTarget)));box.append(head,E('p',value));blocks.push(box);}
 return blocks;
}

// ---- Report cards: only for replies that contain an actual MP4 ----
const videoOf=c=>(c.reply?.artifacts||[]).find(a=>a.mimeType==='video/mp4');
function reportCard(c,number){
 const a=videoOf(c),card=E('article',undefined,'card'),head=E('div',undefined,'card-head'),titles=E('div');
 titles.append(E('h3',(thread?.title||'Report')+(number>1?' · version '+number:'')),E('div','Video report · '+when(c.completedAt||c.createdAt),'when'));
 head.append(titles,E('span','Ready','badge'));card.append(head);
 const player=E('div',undefined,'player');
 const show=r=>{const video=E('video');video.controls=true;video.playsInline=true;video.preload='metadata';video.src=r.url;player.replaceChildren(video,downloadLink(a,r.url,'Save or share video'));};
 if(loaded.has(a.id))show(loaded.get(a.id));
 else{const b=button('▶ Load preview · '+size(a.bytes),async()=>{b.disabled=true;try{show(await loadArtifact(c,a,p=>{b.textContent='Loading '+Math.floor(p*100)+'%';}));}catch(e){message(e.message,true);b.disabled=false;b.textContent='Retry preview';}});player.append(b);}
 card.append(player);
 const blocks=copyBlocks(c.reply);
 if(blocks.length)card.append(...blocks);else card.append(E('div','No separate voiceover or Instagram text came with this report.','copy empty'));
 return card;
}
function paintReports(){
 const box=$('reportCards'),list=(thread?.commands||[]).filter(videoOf);
 for(const [key,el] of cards)if(!list.some(c=>c.id===key)){el.remove();cards.delete(key);}
 list.forEach((c,i)=>{if(!cards.has(c.id))cards.set(c.id,reportCard(c,i+1));});
 [...list].reverse().forEach((c,i)=>{const el=cards.get(c.id);if(box.children[i]!==el)box.insertBefore(el,box.children[i]||null);});
 $('reports').hidden=!list.length;
}

// ---- Conversation ----
function paintConversation(){
 const commands=thread?.commands||[],signature=JSON.stringify(commands.map(c=>[c.id,c.status,c.error,!!c.reply,c.receivedAt]));
 if(signature===convoSignature)return;convoSignature=signature;
 const box=$('messages');box.replaceChildren();$('convo').hidden=!commands.length;
 for(const c of commands){
  const user=E('article',undefined,'bubble user');user.append(E('h3','You'),E('p',c.text));
  user.append(E('div',(statusNames[c.status]||c.status)+(c.receivedAt?' · '+new Date(c.receivedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):''),'status'));
  if(c.status==='queued')user.append(button('Cancel',async()=>{try{paint((await api('producer-cancel',{id,requestID:c.id})).thread);}catch(e){message(e.message,true);}},'ghost small'));
  if(c.error)user.append(E('p',c.error));box.append(user);
  if(!c.reply)continue;
  const reply=E('article',undefined,'bubble');reply.append(E('h3',c.reply.needsAnswer?'Claude · question for you':'Claude'),E('p',c.reply.text));
  if(videoOf(c))reply.append(E('div','The video report card is at the top.','status'));
  else reply.append(...copyBlocks(c.reply));
  for(const a of c.reply.artifacts||[]){if(a.mimeType==='video/mp4'||COPY_FILES.has(a.filename))continue;
   const slot=E('div');reply.append(slot);
   const render=r=>{slot.replaceChildren(downloadLink(a,r.url));if(r.text!==null&&a.mimeType==='text/markdown')slot.append(E('pre',r.text));};
   if(loaded.has(a.id))render(loaded.get(a.id));
   else{const b=button('Open '+a.filename,async()=>{b.disabled=true;try{render(await loadArtifact(c,a,p=>{b.textContent='Loading '+Math.floor(p*100)+'%';}));}catch(e){message(e.message,true);b.disabled=false;b.textContent='Retry '+a.filename;}},'ghost small');slot.append(b);}
  }
  box.append(reply);
 }
}
function paint(t){if(!t)return;thread=t;if(!titleEdited&&document.activeElement!==$('title'))$('title').value=t.title==='New report'?'':t.title;assetPaint();paintReports();paintConversation();}

// ---- Stories ----
function clearStory(){epoch++;for(const r of loaded.values())URL.revokeObjectURL(r.url);loaded.clear();for(const el of cards.values())el.remove();cards.clear();convoSignature='';thread=null;$('messages').replaceChildren();$('convo').hidden=true;$('reports').hidden=true;$('assets').replaceChildren();$('sources').replaceChildren();}
function busyMessage(){if(uploading>0)return 'Wait for the upload to finish first.';if(sending||pending)return 'Finish or retry your saved instruction first.';if($('instruction').value.trim())return 'Send or clear your current text first.';return '';}
async function open(target){
 const why=busyMessage();if(why){message(why,true);return;}
 clearStory();const expected=epoch;const r=await api('producer-get',{id:target});if(expected!==epoch)return;if(!r.thread)throw Error('Story not found.');
 id=target;titleEdited=false;$('title').value='';setPrefs(r.thread.preferences);refs=(r.thread.sourceRefs||[]).map(({kind,id})=>({kind,id}));
 // Every file in the story is available by default; untick to leave one out.
 assetIDs=new Set((r.thread.assets||[]).map(a=>a.id));uploadRows.length=0;$('uploads').replaceChildren();
 sourcePaint();paint(r.thread);history.replaceState(null,'','?story='+id);paintList();message('');
}
function paintList(){
 const box=$('threads');box.replaceChildren();
 for(const t of threads){const b=button('',()=>open(t.id).catch(e=>message(e.message,true)));b.setAttribute('aria-current',t.id===id?'true':'false');
  const label=t.reports>0&&t.status==='ready'?(t.reports===1?'Video report ready':t.reports+' video reports'):statusNames[t.status]||t.status;
  b.append(E('span',t.title),E('small',label));box.append(b);}
 $('more').hidden=!cursor;
}
async function refresh(more=false){
 if(loading||!authenticated||document.hidden)return;loading=true;const expected=epoch;
 try{const r=await api('producer-list',more&&cursor?{cursor}:{});if(expected!==epoch)return;
  const map=new Map((more?threads:[]).map(t=>[t.id,t]));for(const t of r.threads||[])map.set(t.id,t);threads=[...map.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));cursor=r.nextCursor;paintList();
  const healthy=r.health&&Date.now()-Date.parse(r.health.checkedAt)<90000;
  $('health').textContent=healthy?(r.health.status==='storage_offline'?'Mac connected · project SSD unavailable':r.health.status==='storage_full'?'Mac connected · SSD needs space; requests wait':r.health.status==='working'?'● Mac working':'● Mac ready'):'Mac offline · requests wait in the cloud';
  if(id&&thread){const v=await api('producer-get',{id});if(v.thread&&expected===epoch)paint(v.thread);}
 }catch(e){if(authenticated)message(e.message,true);}finally{loading=false;}
}
async function newStory(){
 const why=busyMessage();if(why){message(why,true);return;}
 clearStory();id=await uid();refs=[];assetIDs=new Set();titleEdited=false;$('title').value='';$('files').value='';uploadRows.length=0;$('uploads').replaceChildren();setPrefs();sourcePaint();history.replaceState(null,'','producer.html');paintList();message('');$('instruction').focus();
}

// ---- Send ----
async function deliver(){
 if(!pending)return;sending=true;controls();
 try{const r=await api('producer-send',pending);await local('delete');id=pending.id;pending=null;history.replaceState(null,'','?story='+id);titleEdited=false;$('retry').hidden=true;$('instruction').value='';$('saveState').textContent='Saved in the cloud. Your Mac will pick it up.';paint(r.thread);message('Sent. You can leave this screen; the report card appears here when it’s done.');await refresh();}
 catch(e){$('retry').hidden=false;message(e.message+' Your exact request is saved on this device; retrying won’t create a duplicate.',true);}
 finally{sending=false;controls();}
}
async function send(event){
 event.preventDefault();if(sending||uploading>0)return;if(pending)return deliver();
 const selected=[...assetIDs].filter(a=>thread?.assets?.some(x=>x.id===a));
 let text=$('instruction').value.trim();
 if(!text&&selected.length){text='Make a report from the attached files.';$('instruction').value=text;}
 if(!text){message('Tell Claude what to make, or add files first.',true);$('instruction').focus();return;}
 if(!$('noMusic').checked){$('styleBox').open=true;message('Music isn’t supported yet. Tick “No music” under Style to send.',true);return;}
 // Name a new story from its context; follow-ups keep the name unless you edit it.
 const fresh=!thread||!(thread.commands||[]).length,title=titleEdited&&$('title').value.trim()?$('title').value.trim():fresh&&(!thread||thread.title==='New report')?deriveTitle(text):'';
 pending={id:id||await uid(),requestID:await uid(),text,preferences:prefs(),sourceRefs:refs.map(({kind,id})=>({kind,id})),assetIDs:selected,...(title?{title:title.slice(0,180)}:{})};
 try{await local('put',pending);}catch(e){pending=null;message('Couldn’t save a retry copy, so nothing was sent. Your text is still here. '+e.message,true);return;}
 await deliver();
}

// ---- Start ----
async function start(){
 try{const catalog=await api('producer-catalog');scope=catalog.deviceScope;
  for(const [key,list] of [['format',catalog.catalog.formats],['banner',catalog.catalog.banners],['length',catalog.catalog.lengths]])for(const item of list){const opt=E('option',item.label);opt.value=item.id;$(key).append(opt);}
  setPrefs();store=await openDB();pending=await local('get');const params=new URLSearchParams(location.search);
  if(pending){id=pending.id;$('instruction').value=pending.text;$('title').value=pending.title||'';setPrefs(pending.preferences);refs=pending.sourceRefs||[];assetIDs=new Set(pending.assetIDs);$('retry').hidden=false;message('A previous instruction is saved on this device. Retry sends the same request without duplicating it.');
   try{const r=await api('producer-get',{id});if(r.thread)paint(r.thread);}catch{}}
  else if(/^[a-f0-9]{64}$/.test(params.get('story')||''))await open(params.get('story'));
  else{id=await uid();const ref=params.get('source'),kind=params.get('kind');if(/^[a-f0-9]{64}$/.test(ref||'')&&['tip','note','research'].includes(kind))refs=[{kind,id:ref}];const t=(params.get('title')||'').slice(0,180);if(t){$('title').value=t;titleEdited=true;}}
  sourcePaint();controls();await refresh();
 }catch(e){message(e.message,true);}
}
$('instruction').addEventListener('input',nativeState);
$('title').addEventListener('input',()=>{titleEdited=true;});
for(const k of ['format','banner','length'])$(k).addEventListener('change',styleSummary);
$('compose').addEventListener('submit',send);
$('retry').addEventListener('click',deliver);
$('files').addEventListener('change',()=>{addFiles($('files').files);$('files').value='';});
const drop=$('drop');
drop.addEventListener('dragover',e=>{e.preventDefault();if(!$('files').disabled)drop.classList.add('over');});
drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
drop.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('over');if(!$('files').disabled)addFiles(e.dataTransfer.files);});
// A file dropped anywhere else must not navigate away from unsent work.
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>{e.preventDefault();if(!$('files').disabled&&e.dataTransfer?.files?.length)addFiles(e.dataTransfer.files);});
$('new').addEventListener('click',()=>newStory().catch(e=>message(e.message,true)));
$('more').addEventListener('click',()=>refresh(true));
window.addEventListener('beforeunload',e=>{if(dirty()){e.preventDefault();e.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
setInterval(()=>refresh(),15000);
start();
})();
