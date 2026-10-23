'use strict';
(function(root){
 const ID=/^[a-f0-9]{64}$/;
 const CTA='Send photos or video to me.';
 function lines(ctx,text,maxWidth){const words=String(text||'').trim().split(/\s+/),out=[];let line='';for(const word of words){const next=line?line+' '+word:word;if(ctx.measureText(next).width>maxWidth&&line){out.push(line);line=word;}else line=next;}if(line)out.push(line);return out;}
 function fit(ctx,text,width,size,min,maxLines){let result;for(let n=size;n>=min;n-=2){ctx.font=`700 ${n}px Arial, sans-serif`;result=lines(ctx,text,width);if(result.length<=maxLines&&result.every(l=>ctx.measureText(l).width<=width))return {lines:result,size:n};}throw Error('That text is too long for the story. Shorten it and try again.');}
 function render(canvas,story,art=null){
  if(!String(story.headline||'').trim())throw Error('Add a short question before sharing this story.');
  canvas.width=1080;canvas.height=1920;const c=canvas.getContext('2d');
  c.fillStyle='#132f46';c.fillRect(0,0,1080,1920);
  if(art?.images?.length)root.CerneyStoryBackgrounds.paint(c,art);
  const accent=art?.style.color||'#ea8b77';
  if(story.basis==='demo'){c.fillStyle=accent;c.font='700 25px Arial';c.fillText('DESIGN EXAMPLE · NO REAL INCIDENT',88,320);}
  function block(text,y,width,size,min,maxLines,color,weight='700'){
   const f=fit(c,text,width,size,min,maxLines);c.font=`${weight} ${f.size}px Arial, sans-serif`;c.fillStyle=color;
   for(const [i,line] of f.lines.entries())c.fillText(line,88,y+i*f.size*1.17);
   return y+(f.lines.length-1)*f.size*1.17;
  }
  block(story.headline,580,904,120,66,4,'#ffffff');
  c.fillStyle=accent;c.fillRect(88,1190,180,7);
  block(CTA,1350,904,52,44,2,'#ffffff','400');
  c.font='700 56px Arial';c.fillStyle=accent;c.fillText('chriscerney.org/upload',88,1550);
  return canvas;
 }
 let section,signature='',selected='';
 const cards=new Map();
 const el=(tag,text,cls)=>{const x=document.createElement(tag);if(text)x.textContent=text;if(cls)x.className=cls;return x;};
 function clear(){signature='';selected='';for(const item of cards.values())item.node.dispose();cards.clear();section?.remove();section=null;}
 function card(story){
  const box=el('details',null,'witness-card');box.id='witness-'+story.id;
  const summary=el('summary');summary.append(el('span',story.headline),el('small',story.basis==='demo'?'Example · No alert sent':story.sources.length+' source'+(story.sources.length===1?'':'s')+' · Review & share'));box.append(summary);
  const editor=el('div',null,'witness-editor'),preview=el('img',null,'witness-preview');preview.alt='Instagram Story preview';
  const form=el('div',null,'witness-form'),draft={...story},backgrounds=root.CerneyStoryBackgrounds;
  let look=backgrounds?.suggested(story),manualLook=false,file=null,revision=0,ownURL=null,timer;
  box.dispose=()=>{revision++;clearTimeout(timer);if(ownURL)URL.revokeObjectURL(ownURL);box.remove();};
  const status=el('p',null,'witness-status');status.setAttribute('role','status');
  const share=el('button','Share story image'),download=el('button','Save image','secondary');share.type=download.type='button';share.disabled=download.disabled=true;
  async function prepare(){
   clearTimeout(timer);
   const current=++revision,snapshot={...draft},selectedLook={...look};file=null;share.disabled=download.disabled=true;status.textContent='Preparing image…';
   try{let art=null,plain=false;if(backgrounds){try{art=await backgrounds.load(selectedLook);}catch{plain=true;art=backgrounds.validated(selectedLook);}}
    if(current!==revision||!box.isConnected)return;
    const canvas=render(document.createElement('canvas'),snapshot,art);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if(current!==revision||!box.isConnected)return;if(!blob)throw Error('Could not prepare this image.');
    if(ownURL)URL.revokeObjectURL(ownURL);ownURL=URL.createObjectURL(blob);preview.src=ownURL;
    file=new File([blob],'cerney-story-'+story.id.slice(0,8)+'.png',{type:'image/png'});share.disabled=download.disabled=false;status.textContent=plain?'Background unavailable. Your story is ready with a plain background.':(art?.style.label?art.style.label+' · ':'')+'Ready for your review.';
   }catch(e){if(current===revision)status.textContent=e.message;}
  }
  let syncLook=()=>{};
  if(backgrounds){
   const settings=el('fieldset',null,'witness-appearance');settings.append(el('legend','Appearance'));
   const placeLabel=el('label','Location background'),places=el('select');places.setAttribute('aria-label','Location background');
   for(const place of [...backgrounds.catalog].sort((a,b)=>a.label.localeCompare(b.label))){const option=el('option',place.label+(place.kind==='fallback'?'':' · '+place.counties.join(' / '))); option.value=place.id;places.append(option);}placeLabel.append(places);
   const colorLabel=el('div',null,'witness-urgency');colorLabel.append(el('p','Urgency color','witness-control-label'));
   const colors=el('div',null,'witness-urgency-options');colors.setAttribute('role','group');colors.setAttribute('aria-label','Urgency color');
   const colorButtons=[];
   for(const style of backgrounds.styles){
    const button=el('button',null,'witness-urgency-option');button.type='button';button.setAttribute('aria-label',style.label);button.style.setProperty('--urgency-color',style.color);
    const check=el('span','✓','witness-urgency-check');check.setAttribute('aria-hidden','true');
    button.append(el('span',null,'witness-urgency-swatch'),el('span',style.label),check);
    button.addEventListener('click',()=>{manualLook=true;look={...look,urgency:style.id};syncLook();prepare();});colorButtons.push({button,id:style.id});colors.append(button);
   }colorLabel.append(colors);
   const policeLabel=el('label',null,'witness-police'),police=el('input');police.type='checkbox';police.setAttribute('aria-label','Blurred police lights');policeLabel.append(police,document.createTextNode(' Blurred police lights'));
   syncLook=()=>{places.value=look.locationID;for(const option of colorButtons)option.button.setAttribute('aria-pressed',String(option.id===look.urgency));police.checked=look.policeLights;};syncLook();
   function changed(){manualLook=true;look={...look,locationID:places.value,policeLights:police.checked};prepare();}
   places.addEventListener('change',changed);police.addEventListener('change',changed);
   const reset=el('button','Use suggested appearance','text-button');reset.type='button';reset.addEventListener('click',()=>{manualLook=false;look=backgrounds.suggested(draft);syncLook();prepare();});
   settings.append(placeLabel,colorLabel,policeLabel,el('p','AI illustrations of an area, not incident photos. Use police lights only when they fit the source.','small muted'),reset);form.append(settings);
  }
  for(const [key,label,max] of [['headline','Story question',100]]){
   const field=el('label',label);const input=el('textarea');input.rows=2;input.maxLength=max;input.value=draft[key]||'';input.setAttribute('aria-label',label);
   input.addEventListener('input',()=>{draft[key]=input.value;revision++;file=null;share.disabled=download.disabled=true;if(backgrounds&&!manualLook){look=backgrounds.suggested(draft);syncLook();}clearTimeout(timer);timer=setTimeout(prepare,180);});field.append(input);form.append(field);
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
  if(story.context)notes.append(el('p',story.context));
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
   signature=next;
   if(!section.childNodes.length){
    const h=el('div',null,'witness-heading');const title=el('div');title.append(el('h2','Story requests'));h.append(title,el('span',null,'witness-count'));section.append(h);
    const healthText=el('p',null,'small muted');healthText.id='storyRequestHealth';section.append(healthText);
   }
   const valid=[...new Map(stories.filter(x=>ID.test(x.id||'')).map(story=>[story.id,story])).values()],ids=new Set(valid.map(story=>story.id));
   section.querySelector('.witness-count').textContent=String(valid.length);
   for(const [id,item]of cards){if(!ids.has(id)){item.node.dispose();cards.delete(id);}}
   section.querySelector('.witness-empty')?.remove();
   if(!valid.length)section.append(el('p','New, timely incidents will appear here after checking the available sources.','witness-empty'));
   for(const [index,story] of valid.entries()){
    const source=JSON.stringify(story),previous=cards.get(story.id);let node=previous?.node;
    if(previous?.source!==source){const open=Boolean(node?.open);node?.dispose();node=card(story);node.open=open;cards.set(story.id,{node,source});}
    // Keep the actual editor node, local wording and selected color when only
    // other incidents change during a background inbox refresh.
    const current=section.querySelectorAll('.witness-card')[index];
    if(current!==node)section.insertBefore(node,current||null);
   }
  }
  const healthText=document.getElementById('storyRequestHealth');
  if(healthText)healthText.textContent=health?.checkedAt?(health.status==='attention'?'Story writer needs attention on the Mac. Last check: ':Date.now()-Date.parse(health.checkedAt)>10*60000?'Story monitor needs attention. Last check: ':'Story monitor checked ')+new Date(health.checkedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+(health.pending?' · '+health.pending+' awaiting a check':''):'Story monitor status is not available yet.';
  if(ID.test(requested||'')&&selected!==requested){const box=document.getElementById('witness-'+requested);if(box){box.open=true;box.scrollIntoView({block:'start',behavior:'smooth'});selected=requested;}else{const p=el('p','This story request has expired or is no longer available. New drafts are listed below.','witness-empty');section.prepend(p);selected=requested;}}
 }
 root.CerneyStoryRequests={render,fit,update,clear};
 if(typeof module!=='undefined')module.exports={render,fit,lines};
})(typeof window==='undefined'?globalThis:window);
