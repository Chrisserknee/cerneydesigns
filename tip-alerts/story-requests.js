'use strict';
(function(root){
 const ID=/^[a-f0-9]{64}$/;
 const CTA='Have photos or video? Upload them to my tipline or send them directly to me.';
 function lines(ctx,text,maxWidth){const words=String(text||'').trim().split(/\s+/),out=[];let line='';for(const word of words){const next=line?line+' '+word:word;if(ctx.measureText(next).width>maxWidth&&line){out.push(line);line=word;}else line=next;}if(line)out.push(line);return out;}
 function fit(ctx,text,width,size,min,maxLines){let result;for(let n=size;n>=min;n-=2){ctx.font=`700 ${n}px Arial, sans-serif`;result=lines(ctx,text,width);if(result.length<=maxLines&&result.every(l=>ctx.measureText(l).width<=width))return {lines:result,size:n};}throw Error('That text is too long for the story. Shorten it and try again.');}
 function render(canvas,story){
  canvas.width=1080;canvas.height=1920;const c=canvas.getContext('2d');
  c.fillStyle='#f5f1e9';c.fillRect(0,0,1080,1920);c.fillStyle='#132f46';c.fillRect(0,0,1080,1440);
  c.strokeStyle='#385367';c.lineWidth=2;c.strokeRect(54,142,972,1630);
  c.fillStyle='#ea8b77';c.fillRect(88,218,64,64);c.fillStyle='#132f46';c.font='700 51px Arial';c.fillText('C',101,270);
  c.fillStyle='#f5f1e9';c.font='700 26px Arial';c.fillText('CHRIS CERNEY REPORTS',180,246);c.font='24px Arial';c.fillText('Central Coast • Community reporting',180,279);
  c.fillStyle='#ea8b77';c.font='700 25px Arial';c.fillText(story.basis==='demo'?'DESIGN EXAMPLE · NO REAL INCIDENT':'WERE YOU THERE?',88,365);
  function block(text,y,width,size,min,maxLines,color,weight='700'){
   const f=fit(c,text,width,size,min,maxLines);c.font=`${weight} ${f.size}px Arial, sans-serif`;c.fillStyle=color;
   for(const [i,line] of f.lines.entries())c.fillText(line,88,y+i*f.size*1.17);
   return y+(f.lines.length-1)*f.size*1.17;
  }
  block(story.headline,485,904,86,54,3,'#ffffff');
  c.strokeStyle='#506372';c.beginPath();c.moveTo(88,785);c.lineTo(992,785);c.stroke();
  block(story.question,875,904,58,40,5,'#ffffff');
  block(story.context||'I’m looking for people who saw what happened.',1270,904,34,28,3,'#cad5dd','400');
  block(CTA,1500,904,41,35,3,'#132f46');
  c.font='700 49px Arial';c.fillStyle='#132f46';c.fillText('chriscerney.org/upload',88,1670);
  c.fillStyle='#ea8b77';c.fillRect(88,1710,180,7);
  return canvas;
 }
 let section,signature='',urls=[],timers=[],selected='';
 const el=(tag,text,cls)=>{const x=document.createElement(tag);if(text)x.textContent=text;if(cls)x.className=cls;return x;};
 function clear(){signature='';selected='';for(const u of urls)URL.revokeObjectURL(u);urls=[];for(const t of timers)clearTimeout(t);timers=[];section?.remove();section=null;}
 function card(story){
  const box=el('details',null,'witness-card');box.id='witness-'+story.id;
  const summary=el('summary');summary.append(el('span',story.headline),el('small',story.basis==='demo'?'Example · No alert sent':story.sources.length+' source'+(story.sources.length===1?'':'s')+' · Review & share'));box.append(summary);
  const editor=el('div',null,'witness-editor'),preview=el('img',null,'witness-preview');preview.alt='Instagram Story preview';
  const form=el('div',null,'witness-form'),draft={...story};let file=null,revision=0,ownURL=null;
  const status=el('p',null,'witness-status');status.setAttribute('role','status');
  const share=el('button','Share story image'),download=el('button','Save image','secondary');share.type=download.type='button';share.disabled=download.disabled=true;
  async function prepare(){
   const current=++revision;file=null;share.disabled=download.disabled=true;status.textContent='Preparing image…';
   try{const canvas=render(document.createElement('canvas'),draft);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if(current!==revision||!box.isConnected)return;if(!blob)throw Error('Could not prepare this image.');
    if(ownURL)URL.revokeObjectURL(ownURL);ownURL=URL.createObjectURL(blob);urls.push(ownURL);preview.src=ownURL;
    file=new File([blob],'cerney-story-'+story.id.slice(0,8)+'.png',{type:'image/png'});share.disabled=download.disabled=false;status.textContent='Ready for your review.';
   }catch(e){if(current===revision)status.textContent=e.message;}
  }
  for(const [key,label,max] of [['headline','Headline',100],['question','Question for witnesses',260],['context','Supporting line',200]]){
   const field=el('label',label);const input=el('textarea');input.rows=key==='headline'?2:3;input.maxLength=max;input.value=draft[key]||'';input.setAttribute('aria-label',label);let timer;
   input.addEventListener('input',()=>{draft[key]=input.value;file=null;share.disabled=download.disabled=true;clearTimeout(timer);timer=setTimeout(prepare,180);timers.push(timer);});field.append(input);form.append(field);
  }
  const actions=el('div',null,'witness-actions');actions.append(share,download);form.append(actions,status);
  share.addEventListener('click',()=>{
   if(!file)return; // File is prepared before the tap, preserving iOS user activation.
   if(Date.parse(story.expiresAt)<=Date.now()){status.textContent='This draft has expired. Refresh to check for current story requests.';return;}
   if(!navigator.canShare?.({files:[file]})||!navigator.share){status.textContent='Use Save image, then add it to your Instagram Story.';return;}
   navigator.share({files:[file]}).then(()=>{status.textContent='Image handed to the share sheet. Choose Instagram and Story, then review before posting.';}).catch(e=>{status.textContent=e.name==='AbortError'?'Sharing canceled. Your draft is still here.':'Sharing was unavailable. Save the image, then add it in Instagram.';});
  });
  download.addEventListener('click',()=>{if(!file||!ownURL)return;if(Date.parse(story.expiresAt)<=Date.now()){status.textContent='This draft has expired. Refresh to check for current story requests.';return;}const a=el('a');a.href=ownURL;a.download=file.name;a.click();status.textContent='Save the image, then choose it in Instagram’s Story editor.';});
  form.append(el('p','Choose Instagram in the share sheet, then Story. If Instagram isn’t offered, save the image and add it from Photos. You decide whether to post.','small muted'));
  const copy=el('button','Copy upload link','text-button');copy.type='button';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText('https://www.chriscerney.org/upload');status.textContent='Upload link copied. You can add it as an Instagram link sticker.';}catch{status.textContent='Link: https://www.chriscerney.org/upload';}});form.append(copy);
  const notes=el('details',null,'witness-notes');notes.append(el('summary','Sources & review notes'));
  notes.append(el('p',story.reviewNote||'Check the location and timing before sharing.'));
  if(story.timeLabel)notes.append(el('p','Incident timing: '+story.timeLabel));
  notes.append(el('p','Prepared '+new Date(story.createdAt).toLocaleString()+' · Available until '+new Date(story.expiresAt).toLocaleString()));
  for(const s of story.sources){const p=el('p',s.label);if(ID.test(s.tipId||'')){const a=el('a','Open linked tip');a.href='/tip-alerts/?tip='+s.tipId;p.append(document.createTextNode(' · '),a);}notes.append(p);}
  form.append(notes);editor.append(preview,form);box.append(editor);
  let prepared=false;box.addEventListener('toggle',()=>{if(box.open&&!prepared){prepared=true;prepare();}});
  return box;
 }
 function update(stories=[],health=null){
  const connected=document.getElementById('connected');if(!connected)return;
  const next=JSON.stringify(stories);const requested=new URLSearchParams(location.search).get('story');
  if(!section){section=el('section',null,'witness-section');section.id='storyRequests';const heading=connected.querySelector('.desk-heading');heading?heading.after(section):connected.prepend(section);}
  if(signature!==next || !section.childNodes.length){
   for(const u of urls)URL.revokeObjectURL(u);urls=[];section.replaceChildren();signature=next;selected='';
   const h=el('div',null,'witness-heading');const title=el('div');title.append(el('p','ASK YOUR COMMUNITY','eyebrow'),el('h2','Story requests'),el('p','Ready-to-share images asking witnesses for photos and video.','muted'));h.append(title,el('span',String(stories.length),'witness-count'));section.append(h);
   const healthText=el('p',null,'small muted');healthText.id='storyRequestHealth';section.append(healthText);
   if(!stories.length)section.append(el('p','New, timely incidents will appear here after checking the available sources.','witness-empty'));
   for(const s of stories.filter(x=>ID.test(x.id||'')))section.append(card(s));
  }
  const healthText=document.getElementById('storyRequestHealth');
  if(healthText)healthText.textContent=health?.checkedAt?(health.status==='attention'?'Story writer needs attention on the Mac. Last check: ':Date.now()-Date.parse(health.checkedAt)>10*60000?'Story monitor needs attention. Last check: ':'Story monitor checked ')+new Date(health.checkedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+(health.pending?' · '+health.pending+' awaiting a check':''):'Story monitor status is not available yet.';
  if(ID.test(requested||'')&&selected!==requested){const box=document.getElementById('witness-'+requested);if(box){box.open=true;box.scrollIntoView({block:'start',behavior:'smooth'});selected=requested;}else{const p=el('p','This story request has expired or is no longer available. New drafts are listed below.','witness-empty');section.prepend(p);selected=requested;}}
 }
 root.CerneyStoryRequests={render,fit,update,clear};
 if(typeof module!=='undefined')module.exports={render,fit,lines};
})(typeof window==='undefined'?globalThis:window);
