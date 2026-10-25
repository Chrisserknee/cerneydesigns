'use strict';
(()=>{
 const E=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
 let root,api,loading=false,last=0,notes=[],selected=null,recorder=null,chunks=[],stream=null,started=0,elapsed=0,recorded=null,uploadID=null,uploadNote=null,alertLimit=6,session=0,alertFilter='All';
 const stamp=()=>new Date().toISOString();
 const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
 const base64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
 function link(source){const a=E('a',source.label||'Open source');try{const u=new URL(source.url);if(u.protocol!=='https:'||u.username||u.password)throw Error();a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';return a;}catch{return E('span',source.label||'Source');}}
 function ensure(){if(root)return;root=E('section');root.id='newsroom';root.className='newsroom';document.querySelector('.desk-heading').after(root);}
 function status(text){const e=document.getElementById('fieldStatus');if(e)e.textContent=text;}
 function button(text,fn){const b=E('button',text);b.type='button';b.addEventListener('click',fn);return b;}
 function fieldUI(){
  const panel=E('details');panel.id='fieldMode';panel.append(E('summary','Field Mode · Record a voiceover'));
  const body=E('div');body.className='field-body';body.append(E('p','Record a take, save the original audio, then develop a story from the full transcript.'));
  const timer=E('strong','00:00');timer.id='fieldTimer';timer.className='field-timer';body.append(timer);
  const actions=E('div');actions.className='field-actions';
  const record=button('Record',async()=>{
   try{
    if(recorder?.state==='recording'){elapsed+=Date.now()-started;recorder.pause();record.textContent='Resume';status('Paused');return;}
    if(recorder?.state==='paused'){started=Date.now();recorder.resume();record.textContent='Pause';status('Recording…');return;}
    if(recorded&&!confirm('This take has not been submitted. Discard it and record a new take?'))return;
    stream=await navigator.mediaDevices.getUserMedia({audio:true});chunks=[];recorded=null;uploadID=null;uploadNote=null;selected=null;
    const mime=MediaRecorder.isTypeSupported('audio/mp4')?'audio/mp4':'audio/webm';
    recorder=new MediaRecorder(stream,{mimeType:mime,audioBitsPerSecond:64000});
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onstop=()=>{recorded=new Blob(chunks,{type:mime});stream.getTracks().forEach(t=>t.stop());record.textContent='Record new take';status('Recording saved in this tab. Submit it or download the original before closing.');submit.disabled=false;download.disabled=false;};
    recorder.start(1000);started=Date.now();elapsed=0;record.textContent='Pause';submit.disabled=true;download.disabled=true;status('Recording…');
   }catch{status('Microphone unavailable. Allow microphone access in your browser, then try again.');}
  });
  const finish=()=>{if(recorder&&recorder.state!=='inactive'){if(recorder.state==='recording')elapsed+=Date.now()-started;recorder.stop();}};
  const stop=button('Finish',finish);
  const download=button('Download original',()=>{if(!recorded)return;const url=URL.createObjectURL(recorded),a=E('a');a.href=url;a.download='Cerney-field-recording.'+(recorded.type==='audio/webm'?'webm':'m4a');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});download.disabled=true;
  const submit=button('Submit recording',async()=>{
   if(!recorded)return;submit.disabled=true;
   try{status('Saving original recording…');const bytes=new Uint8Array(await recorded.arrayBuffer());if(bytes.length>32*1024*1024)throw Error('Recording is too large. Keep this tab open to save your take.');
    const id=uploadID||(uploadID=await hash(new TextEncoder().encode(crypto.randomUUID())));const note=uploadNote||(uploadNote={id,revision:1,title:'Field recording · '+new Date().toLocaleString(),createdAt:stamp(),transcript:'',draft:'',notes:'',duration:Math.min(1800,elapsed/1000),relatedIDs:[],processRequested:true});
    await api('field-save',{id,note,expectedRevision:0});let parts=[];
    for(let offset=0;offset<bytes.length;offset+=512*1024){const chunk=bytes.slice(offset,offset+512*1024),sha256=await hash(chunk);await api('field-audio-part',{id,index:parts.length,sha256,base64:base64(chunk)});parts.push(sha256);}
    await api('field-audio-finish',{id,parts,sha256:await hash(bytes),mimeType:recorded.type});recorded=null;download.disabled=true;status('Saved securely. Transcription and story development will continue on your Mac when available.');last=0;await refresh(api);
   }catch(e){status(e.message||'Upload interrupted. Keep this tab open and retry.');submit.disabled=false;}
  });submit.disabled=true;
  actions.append(record,stop,submit,download);body.append(actions);const state=E('p');state.id='fieldStatus';state.setAttribute('role','status');body.append(state);
  const library=E('div');library.id='fieldLibrary';body.append(library);panel.append(body);
  const interval=setInterval(()=>{if(!root?.isConnected){clearInterval(interval);return;}if(recorder?.state==='recording'){const n=Math.floor((elapsed+Date.now()-started)/1000);timer.textContent=String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');if(n>=1800)finish();}},500);
  window.addEventListener('beforeunload',event=>{if(recorded||recorder?.state==='recording'||recorder?.state==='paused'){event.preventDefault();event.returnValue='';}});
  return panel;
 }
 async function openNote(id){
  const expected=session;const {note}=await api('field-get',{id});if(!note||session!==expected)return;selected=note;
  const box=document.getElementById('fieldLibrary');box.replaceChildren();const title=E('input');title.value=note.title;title.setAttribute('aria-label','Recording title');box.append(title,E('p',note.processingError||note.processingStatus||'Saved'));
  const transcript=E('details');transcript.append(E('summary','Full voiceover transcript'),E('p',note.transcript||'Waiting for transcription. Original audio is preserved.'));box.append(transcript);
  const label=E('label','Story draft'),draft=E('textarea');draft.value=note.draft;draft.rows=12;draft.setAttribute('aria-label','Story draft');label.append(draft);box.append(label);
  const notesLabel=E('label','Reporting notes / direction for AI'),notesInput=E('textarea');notesInput.value=note.notes;notesInput.rows=4;notesInput.setAttribute('aria-label','Reporting notes');notesLabel.append(notesInput);box.append(notesLabel);
  async function save(develop){try{const proposed={...selected,title:title.value,draft:draft.value,notes:notesInput.value,revision:selected.revision+1,processRequested:develop};const result=await api('field-save',{id,note:proposed,expectedRevision:selected.revision});selected=result.note;status(develop?'Saved. AI development is queued.':'Notes saved.');}catch(e){status(e.message);}}
  box.append(button('Save notes',()=>save(false)),button('Develop story with AI',()=>save(true)),button('Refresh transcript',()=>openNote(id)),button('All recordings',()=>{selected=null;last=0;refresh(api);}));
 }
 function paint(data){
  ensure();if(!document.getElementById('fieldMode')){root.append(fieldUI());const heading=E('h2','Source alerts');root.append(heading);const alerts=E('div');alerts.id='researchAlerts';root.append(alerts);}
  const list=document.getElementById('researchAlerts');list.replaceChildren();
  const time=Date.parse(data.monitor?.checkedAt);list.append(E('p',Number.isFinite(time)?'Research sync '+new Date(time).toLocaleTimeString()+(Date.now()-time>180000?' · needs attention':''):'Research sync has not checked in yet.'));
  const collected=Date.parse(data.monitor?.collection?.lastReportAt);if(data.monitor?.collection?.hold)list.append(E('p','Facebook collection is paused pending your resume. These are saved source reports.'));
  list.append(E('p',Number.isFinite(collected)?'Last group collection report: '+new Date(collected).toLocaleString()+(Date.now()-collected>7200000?' · coverage needs attention':''):'No group collection report received.'));
  const filters=E('div');filters.className='field-actions';for(const name of ['All','Facebook','Email']){const b=button(name,()=>{alertFilter=name;alertLimit=6;paint(data);});b.setAttribute('aria-pressed',alertFilter===name?'true':'false');filters.append(b);}list.append(filters);
  const target=new URLSearchParams(location.search).get('alert'),all=(data.alerts||[]).filter(a=>a.id===target||alertFilter==='All'||(alertFilter==='Facebook'?a.kind==='facebook_group':a.kind.includes('email'))),targetIndex=all.findIndex(a=>a.id===target);alertLimit=Math.max(alertLimit,targetIndex+1);
  for(const a of all.slice(0,alertLimit)){const card=E('details');card.className='research-card';card.id='alert-'+a.id;const summary=E('summary'),observed=Date.parse(a.observedAt);summary.append(E('small',(a.kind==='facebook_group'?'Facebook alert':a.kind==='official_email'?'Official email':a.kind.includes('email')?'Email lead':a.kind==='official_statement'?'Official statement':'Source alert')+' · '+a.priority),E('strong',a.title),E('small','Observed '+(Number.isFinite(observed)?new Date(observed).toLocaleString(): 'time unknown')+' · '+a.timeLabel));card.append(summary,E('p',a.summary),E('p',(a.location||'Location unconfirmed')+' · '+a.timeLabel));if(a.whatChanged)card.append(E('p','What changed: '+a.whatChanged));card.append(E('p',a.verification));for(const s of a.sources||[])card.append(link(s));for(const q of a.questions||[])card.append(E('p','To check: '+q));for(const c of a.contradictions||[])card.append(E('p','Conflicting accounts: '+c));list.append(card);if(target===a.id)card.open=true;}
  if(all.length>alertLimit)list.append(button('Show more source alerts · '+(all.length-alertLimit)+' remaining',()=>{alertLimit+=10;paint(data);}));
  if(!data.alerts?.length)list.append(E('p','Facebook and email findings will appear here as they are collected.'));
  notes=data.notes||[];if(!selected){const library=document.getElementById('fieldLibrary');library.replaceChildren(E('h3','Your recordings'));for(const n of notes)library.append(button(n.title,()=>openNote(n.id)));}
 }
 async function refresh(request){api=request;if(loading||Date.now()-last<30000)return;const expected=session;loading=true;try{const data=await api('newsroom');if(session!==expected)return;paint(data);last=Date.now();}catch(e){if(session!==expected)return;ensure();if(!root.children.length)root.append(E('p','Research feed unavailable. Refresh to retry.'));}finally{if(session===expected)loading=false;}}
 function clear(){session++;loading=false;if(recorder){recorder.onstop=null;if(recorder.state!=='inactive')recorder.stop();}stream?.getTracks().forEach(t=>t.stop());root?.remove();root=null;selected=null;notes=[];recorded=null;chunks=[];uploadNote=null;uploadID=null;last=0;alertLimit=6;}
 globalThis.CerneyNewsroom={refresh,clear};
})();
