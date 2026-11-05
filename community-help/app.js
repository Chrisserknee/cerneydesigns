import {safeURL,availability,feedbackURL} from './policy.mjs';
const root=document.getElementById('cards'),status=document.getElementById('status'),search=document.getElementById('search');
const date=value=>new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Los_Angeles'}).format(new Date(value))+' Pacific';
let cards=[];
function element(tag,text,className){const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;}
function link(text,url,className){const node=element('a',text,className);node.href=url;return node;}
function render(){
 const term=search.value.trim().toLocaleLowerCase();
 const hash=location.hash.slice(1);
 const matches=cards.filter(c=>!term||[c.title,c.message,c.area,c.details].join(' ').toLocaleLowerCase().includes(term));
 // Keep the linked item visible after expiry; never present an old event as upcoming.
 const visible=matches.filter(c=>availability(c)==='Source checked'||c.id===hash);
 root.replaceChildren();status.textContent=`${visible.length} resource${visible.length===1?'':'s'} shown. Dates and times are Pacific.`;
 for(const c of visible){
  const state=availability(c),current=state==='Source checked';
  const box=element('article','',current?'':'expired');box.id=c.id;
  box.append(element('p',c.area,'meta'),element('h2',c.title),element('p',current?c.message:state+' — check the provider for current information.',current?'':'status'));
  if(current){box.append(element('h3','Before you go'),element('p',c.details,'details'));}
  else box.append(element('p','This saved link is retained for reference. Its old schedule or offer is no longer presented as current.'));
  if(c.endsAt)box.append(element('p','Listed end: '+date(c.endsAt),'meta'));
  const source=element('div','','source');
  source.append(element('p','Source checked '+date(c.checkedAt)),element('p','Recheck due '+date(c.reviewBy)));
  const sourceURL=safeURL(c.sourceURL),actionURL=safeURL(c.actionURL);
  if(sourceURL)source.append(link(c.sourceName+' · original source',sourceURL));
  box.append(source);
  if(actionURL)box.append(link('Check with the provider',actionURL,'action'));
  const feedback=element('div','','feedback');feedback.append(link('This helped',feedbackURL(c.id,'helped')),link('Information is wrong',feedbackURL(c.id,'correction')));box.append(feedback);
  box.append(element('p','Feedback opens a private message to Chris. You review it before sending.','meta'));root.append(box);
 }
 if(!visible.length)root.append(element('p','No matching current listings. Try another search, or tell Chris what you need help finding.'));
}
try{const response=await fetch('/community-help/catalog.json',{cache:'no-store'});if(!response.ok)throw Error();const data=await response.json();if(!Array.isArray(data)||data.length>500)throw Error();cards=data.filter(c=>/^[a-z0-9-]{1,80}$/.test(c.id));render();if(location.hash)document.getElementById(location.hash.slice(1))?.scrollIntoView();}catch{status.textContent='Resources could not be loaded. Please try again.';}
search.addEventListener('input',render);window.addEventListener('hashchange',render);setInterval(render,60000);
