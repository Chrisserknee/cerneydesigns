'use strict';
(function(root){
 const ID=/^[a-f0-9]{64}$/;
 const TEXT_SCALE=0.70; // Shrink fitted copy, including long headlines, by 30%.
 const CTA='Send photos or video to me.';
 function lines(ctx,text,maxWidth){const words=String(text||'').trim().split(/\s+/),out=[];let line='';for(const word of words){const next=line?line+' '+word:word;if(ctx.measureText(next).width>maxWidth&&line){out.push(line);line=word;}else line=next;}if(line)out.push(line);return out;}
 function fit(ctx,text,width,size,min,maxLines){let result;for(let n=size;n>=min;n-=2){ctx.font=`700 ${n}px Arial, sans-serif`;result=lines(ctx,text,width);if(result.length<=maxLines&&result.every(l=>ctx.measureText(l).width<=width))return {lines:result,size:n};}throw Error('That text is too long for the story. Shorten it and try again.');}
 function render(canvas,story,art=null){
  if(!String(story.headline||'').trim())throw Error('Add a short question before sharing this story.');
  canvas.width=1080;canvas.height=1920;const c=canvas.getContext('2d');
  c.fillStyle='#132f46';c.fillRect(0,0,1080,1920);
  if(art?.images?.length)root.CerneyStoryBackgrounds.paint(c,art);
  const accent=art?.style.color||'#ea8b77';
  if(story.basis==='demo'){c.fillStyle=accent;c.font=`700 ${25*TEXT_SCALE}px Arial`;c.fillText('DESIGN EXAMPLE · NO REAL INCIDENT',88,320);}
  function block(text,y,width,size,min,maxLines,color,weight='700'){
   const f=fit(c,text,width,size,min,maxLines);f.size*=TEXT_SCALE;c.font=`${weight} ${f.size}px Arial, sans-serif`;f.lines=lines(c,text,width);c.fillStyle=color;
   for(const [i,line] of f.lines.entries())c.fillText(line,88,y+i*f.size*1.17);
   return y+(f.lines.length-1)*f.size*1.17;
  }
  block(story.headline,580,904,120,66,4,'#ffffff');
  c.fillStyle=accent;c.fillRect(88,1190,180,7);
  block(CTA,1350,904,52,44,2,'#ffffff','400');
  c.font=`700 ${56*TEXT_SCALE}px Arial`;c.fillStyle=accent;c.fillText('chriscerney.org/upload',88,1550);
  return canvas;
 }
 let section,signature='',selected='';
 const cards=new Map();
 const el=(tag,text,cls)=>{const x=document.createElement(tag);if(text)x.textContent=text;if(cls)x.className=cls;return x;};
 function clear(){signature='';selected='';for(const item of cards.values())item.node.dispose();cards.clear();section?.remove();section=null;}
 function card(story){
  const box=el('details',null,'witness-card');box.id='witness-'+story.id;
  const summary=el('summary');summary.append(el('span',story.headline),el('small',story.basis==='demo'?'Example · No alert sent':story.sources.length+' source'+(story.sources.length===1?'':'s')));box.append(summary);
  const editor=el('div',null,'witness-editor'),preview=el('img',null,'witness-preview');preview.alt='Instagram Story preview: '+story.headline;
  const form=el('div',null,'witness-form'),backgrounds=root.CerneyStoryBackgrounds;
  const look=backgrounds?.suggested(story);
  let file=null,revision=0,ownURL=null,downloadFallback=false;
  box.dispose=()=>{revision++;if(ownURL)URL.revokeObjectURL(ownURL);box.remove();};
  const status=el('p',null,'witness-status');status.setAttribute('role','status');
  const share=el('button','Share to Instagram');share.type='button';share.disabled=true;
  async function prepare(){
   const current=++revision;file=null;share.disabled=true;status.textContent='Preparing image…';
   try{let art=null,plain=false;if(backgrounds){try{art=await backgrounds.load(look);}catch{plain=true;art=backgrounds.validated(look);}}
    if(current!==revision||!box.isConnected)return;
    const canvas=render(document.createElement('canvas'),story,art);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if(current!==revision||!box.isConnected)return;if(!blob)throw Error('Could not prepare this image.');
    if(ownURL)URL.revokeObjectURL(ownURL);ownURL=URL.createObjectURL(blob);preview.src=ownURL;
    file=new File([blob],'cerney-story-'+story.id.slice(0,8)+'.png',{type:'image/png'});share.disabled=false;status.textContent=plain?'Background unavailable. A plain image is ready.':'Ready to share.';
   }catch(e){if(current===revision)status.textContent=e.message;}
  }
  function saveImage(){const a=el('a');a.href=ownURL;a.download=file.name;a.click();status.textContent='Save the image, then add it from Photos in Instagram’s Story editor.';}
  const actions=el('div',null,'witness-actions');actions.append(share);form.append(actions,status);
  share.addEventListener('click',()=>{
   if(!file)return; // Prepared before the tap, preserving iOS user activation.
   if(Date.parse(story.expiresAt)<=Date.now()){status.textContent='This draft has expired. Refresh for current requests.';return;}
   if(downloadFallback||!navigator.canShare?.({files:[file]})||!navigator.share){saveImage();return;}
   navigator.share({files:[file]}).then(()=>{status.textContent='Choose Instagram, then Story, in the share sheet.';}).catch(e=>{
    if(e.name==='AbortError'){status.textContent='Sharing canceled.';return;}
    downloadFallback=true;status.textContent='Sharing is unavailable. Tap Share to Instagram again to save the image, then add it in Instagram.';
   });
  });
  if(story.timeLabel)form.append(el('p',story.timeLabel,'small muted'));
  const notes=el('details',null,'witness-notes');notes.append(el('summary','Sources & timing'));
  if(story.context)notes.append(el('p',story.context));
  notes.append(el('p',story.reviewNote||'Check the location and timing before sharing.'));
  notes.append(el('p','Prepared '+new Date(story.createdAt).toLocaleString()+' · Available until '+new Date(story.expiresAt).toLocaleString()));
  for(const source of story.sources){const p=el('p',source.label);if(ID.test(source.tipId||'')){const a=el('a','Open linked tip');a.href='/tip-alerts/?tip='+source.tipId;p.append(document.createTextNode(' · '),a);}notes.append(p);}
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
   if(!valid.length)section.append(el('p','Suitable recent tips will become Story drafts after a source check. Every imported tip remains in the inbox.','witness-empty'));
   for(const [index,story] of valid.entries()){
    const source=JSON.stringify(story),previous=cards.get(story.id);let node=previous?.node;
    if(previous?.source!==source){const open=Boolean(node?.open);node?.dispose();node=card(story);node.open=open;cards.set(story.id,{node,source});}
    // Keep the prepared image when only other incidents change during refresh.
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
