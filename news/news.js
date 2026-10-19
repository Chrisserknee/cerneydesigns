'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const params=new URLSearchParams(location.search);
  const linkParams=new URLSearchParams(location.hash.slice(1));
  let pendingLink=linkParams.get('signin'), unsubscribe=linkParams.get('unsubscribe');
  if (pendingLink || unsubscribe) history.replaceState({},'',location.pathname+location.search);
  let view=['video','image','saved'].includes(params.get('view')) ? params.get('view') : 'all';
  let member={authenticated:false}, posts=[],nextOffset=null,requestNumber=0,searchTimer,toastTimer;
  const postId=params.get('post');
  const element=(tag,className,value)=>{const el=document.createElement(tag);if(className)el.className=className;if(value!==undefined)el.textContent=value;return el;};
  function icon(name) {const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href','/news/icons.svg#'+name);svg.setAttribute('aria-hidden','true');svg.append(use);return svg;}
  async function api(body) {const response=await fetch('/api/news',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error || 'Please try again.');return data;}
  function toast(message) {$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
  function account() {$('join-view').hidden=member.authenticated;$('member-view').hidden=!member.authenticated;$('account-message').textContent='';if(member.authenticated){$('member-email').textContent=member.email;$('member-updates').checked=member.updates;}$('account-dialog').showModal();}
  document.querySelectorAll('.account-button').forEach(button=>button.addEventListener('click',account));
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
  function updateAccount() {document.querySelectorAll('.join-button').forEach(b=>b.textContent=member.authenticated ? 'My account' : 'Join free ↗');document.querySelectorAll('.rail .account-button span').forEach(s=>s.textContent=member.authenticated ? 'My account' : 'Join / sign in');}
  function showMessage(id,message,error=false) {const el=$(id);el.textContent=message;el.classList.toggle('error',error);}
  const videoObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{if(!entry.isIntersecting)entry.target.pause();}),{threshold:.3});
  function renderPost(post) {
    const card=element('article','post');card.id='post-'+post.id;
    const header=element('header','post-header'),avatar=element('div','avatar','CC'),author=element('div');
    avatar.setAttribute('aria-hidden','true');author.append(element('div','post-author','Chris Cerney'));
    const date=element('time','post-date',new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric'}).format(new Date(post.publishAt)));date.dateTime=post.publishAt;author.append(date);header.append(avatar,author);
    if(post.topic)header.append(element('span','topic',post.topic));card.append(header);
    if(post.media.length){
      const gallery=element('div','gallery');gallery.setAttribute('aria-label','Media for '+post.title);gallery.tabIndex=0;
      for(const file of post.media){
        const frame=element('figure','media-frame');let media;
        if(file.type.startsWith('video/')){media=element('video');media.controls=true;media.playsInline=true;media.preload='metadata';media.setAttribute('aria-label',file.alt || post.title);media.addEventListener('play',()=>document.querySelectorAll('video').forEach(other=>{if(other!==media)other.pause();}));videoObserver.observe(media);}
        else{media=element('img');media.alt=file.alt || post.title;media.loading='lazy';media.decoding='async';}
        media.src=file.url;frame.append(media);
        media.addEventListener('error',()=>{if(!frame.querySelector('.media-error'))frame.append(element('p','media-error','Media could not load. Try reloading this story.'));});
        const expand=element('button','expand');expand.type='button';expand.setAttribute('aria-label','View media fullscreen');expand.append(icon('expand'));expand.addEventListener('click',async()=>{try{if(frame.requestFullscreen)await frame.requestFullscreen();else if(media.webkitEnterFullscreen)media.webkitEnterFullscreen();else window.open(file.url,'_blank','noopener');}catch{toast('Use your video player’s fullscreen control.');}});frame.append(expand);gallery.append(frame);
      }
      card.append(gallery);if(post.media.length>1)card.append(element('p','media-count',post.media.length+' photos / videos · swipe to see more'));
    }
    const actions=element('div','post-actions');
    const saved=member.saved?.includes(post.id)===true,save=element('button');save.type='button';save.setAttribute('aria-pressed',String(saved));save.append(icon('bookmark'),element('span','',saved?'Saved':'Save'));
    save.addEventListener('click',async()=>{if(!member.authenticated)return account();save.disabled=true;try{member=await api({op:'save-story',id:post.id,saved:save.getAttribute('aria-pressed')!=='true'});const value=member.saved.includes(post.id);save.setAttribute('aria-pressed',String(value));save.querySelector('span').textContent=value?'Saved':'Save';if(view==='saved'&&!value)void load();}catch(error){toast(error.message);}finally{save.disabled=false;}});
    const share=element('button');share.type='button';share.append(icon('share'),element('span','','Share'));share.addEventListener('click',async()=>{try{if(navigator.share)await navigator.share({title:post.title,url:post.permalink});else{await navigator.clipboard.writeText(post.permalink);toast('Story link copied.');}}catch(error){if(error.name!=='AbortError')toast('Open this story and copy its address to share.');}});
    actions.append(save,share);card.append(actions);
    const copy=element('div','post-copy'),heading=element('h2'),permalink=element('a','',post.title);permalink.href=post.permalink;heading.append(permalink);copy.append(heading,element('p','',post.caption));if(post.location)copy.append(element('p','location',post.location));card.append(copy);return card;
  }
  function empty() {
    const box=element('section','empty-state'),symbol=element('div','empty-icon');symbol.append(icon(view==='saved'?'bookmark':'play'));box.append(symbol);
    const searching=$('search').value.trim();
    let title='A new home for the reporting.',message='The first posts will appear here. Join free to save stories and choose email updates as the reporting gets underway.';
    if(postId){title='This story is unavailable.';message='It may be a draft, scheduled for later, or no longer published.';}
    else if(searching){title='No stories found.';message='Try another name, place or topic.';}
    else if(view==='saved'){title=member.authenticated?'Your saved stories live here.':'Keep the stories that matter.';message=member.authenticated?'Tap Save on a published story to return to it here.':'Join free or sign in to keep a personal collection of reporting.';}
    else if(view==='video'){title='Video reporting, right here.';message='Published videos will appear here, with full-screen playback and a direct link to each story.';}
    else if(view==='image'){title='Stories told in photographs.';message='Published photos and galleries will appear here.';}
    box.append(element('p','eyebrow','CHRIS CERNEY NEWS'),element('h2','',title),element('p','',message));
    const actions=element('div','empty-actions');
    if(!member.authenticated&&!searching){const join=element('button','primary','Join free ↗');join.addEventListener('click',account);actions.append(join);}
    const archive=element('a','secondary',postId?'Back to the feed':'Explore the portfolio ↗');archive.href=postId?'/news/':'/portfolio/';actions.append(archive);box.append(actions);return box;
  }
  function setActive(){document.querySelectorAll('[data-view]').forEach(b=>{const active=b.dataset.view===view;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});document.querySelectorAll('[data-nav]').forEach(b=>b.classList.toggle('current',b.dataset.nav===view));$('feed').classList.toggle('video-view',view==='video');$('search').disabled=view==='saved'||Boolean(postId);}
  async function load(append=false){
    const number=++requestNumber;setActive();$('feed-status').textContent=append?'Loading more stories…':'Loading the latest reporting…';$('load-more').hidden=true;
    try{
      let data;
      if(view==='saved'){data=member.authenticated?await api({op:'saved-feed'}):{posts:[],nextOffset:null};}
      else{const query=new URLSearchParams({op:'feed',offset:append?String(nextOffset || 0):'0'});if(postId)query.set('id',postId);if(view!=='all')query.set('type',view);if($('search').value.trim())query.set('q',$('search').value.trim());const res=await fetch('/api/news?'+query);data=await res.json();if(!res.ok)throw new Error(data.error || 'Could not load stories.');}
      if(number!==requestNumber)return;
      posts=append?[...posts,...data.posts]:data.posts;nextOffset=data.nextOffset;
      if(!append){videoObserver.disconnect();$('feed').replaceChildren();if(postId){const back=element('a','single-back','← All reporting');back.href='/news/';$('feed').append(back);}}
      for(const post of data.posts)$('feed').append(renderPost(post));
      if(!posts.length)$('feed').append(empty());
      $('feed-status').textContent=posts.length? (view==='saved'?'Your saved reporting':'Latest reporting · newest first'):'';$('load-more').hidden=nextOffset===null;
    }catch(error){if(number!==requestNumber)return;$('feed-status').textContent=error.message+' ';const retry=element('button','secondary','Try again');retry.addEventListener('click',()=>load());$('feed-status').append(retry);}
  }
  document.querySelectorAll('[data-view],[data-nav]').forEach(button=>button.addEventListener('click',event=>{if(postId){event.preventDefault();const target=button.dataset.view || button.dataset.nav;location.href=target==='all'?'/news/':'/news/?view='+target;return;}event.preventDefault();view=button.dataset.view || button.dataset.nav;history.replaceState({},'',view==='all'?'/news/':'/news/?view='+view);void load();}));
  $('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(),300);});$('load-more').addEventListener('click',()=>load(true));
  $('join-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;showMessage('account-message','Sending your secure link…');try{await api({op:'signin',email:$('email').value,consent:$('consent').checked,updates:$('updates').checked});showMessage('account-message','Check your email for a sign-in link. It expires in 15 minutes.');}catch(error){showMessage('account-message',error.message,true);}finally{button.disabled=false;}});
  $('preferences').addEventListener('click',async()=>{try{member=await api({op:'preferences',updates:$('member-updates').checked});showMessage('account-message','Preferences saved.');}catch(error){showMessage('account-message',error.message,true);}});
  $('logout').addEventListener('click',async()=>{try{await api({op:'logout'});member={authenticated:false};updateAccount();$('account-dialog').close();void load();}catch(error){showMessage('account-message',error.message,true);}});
  $('delete-account').addEventListener('click',async()=>{if(!confirm('Delete your free account and saved stories? This also stops email updates.'))return;try{await api({op:'delete-account'});member={authenticated:false};updateAccount();$('account-dialog').close();toast('Your account and saved stories have been deleted.');void load();}catch(error){showMessage('account-message',error.message,true);}});
  function randomToken(){const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');}
  const exchange=randomToken();
  $('confirm-link').addEventListener('click',async()=>{const button=$('confirm-link');button.disabled=true;try{if(unsubscribe){await api({op:'unsubscribe',token:unsubscribe});toast('Email updates are turned off.');}else{member=await api({op:'confirm',link:pendingLink,exchange});updateAccount();toast('You’re signed in. Welcome.');}$('link-dialog').close();void load();}catch(error){showMessage('link-message',error.message,true);}finally{button.disabled=false;}});
  function showLink(){if(!pendingLink&&!unsubscribe)return;$('account-dialog').close();showMessage('link-message','');$('link-title').textContent=unsubscribe?'Turn off email updates?':'Finish signing in';$('link-text').textContent=unsubscribe?'You can keep your account and saved stories. Only email updates will stop.':'Confirm to sign in securely on this device.';$('confirm-link').textContent=unsubscribe?'Unsubscribe':'Continue';if(!$('link-dialog').open)$('link-dialog').showModal();}
  window.addEventListener('hashchange',()=>{const links=new URLSearchParams(location.hash.slice(1));pendingLink=links.get('signin');unsubscribe=links.get('unsubscribe');if(pendingLink||unsubscribe){history.replaceState({},'',location.pathname+location.search);showLink();}});
  async function boot(){try{member=await api({op:'status'});}catch{}updateAccount();await load();if(pendingLink||unsubscribe)showLink();else if(params.get('join')==='1')account();}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)document.querySelectorAll('video').forEach(v=>v.pause());});
  void boot();
})();
