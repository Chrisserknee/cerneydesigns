'use strict';
const {createHash}=require('node:crypto');
const sha=x=>createHash('sha256').update(x).digest('hex');
const words=x=>String(x||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(Boolean);
const cities=['salinas','seaside','monterey','marina','carmel','pacific grove','soledad','greenfield','king city','gonzales','watsonville','santa cruz','capitola','aptos','hollister','la jolla'];
const generic=new Set(words('reported report reports incident police sheriff county city near outside people person street road drive avenue boulevard highway north south east west update new today yesterday happened taken custody unconfirmed allegedly according source says said location california ca the and with from that this were have into there their they about after before'));
function terms(text){return new Set(words(text).filter(w=>w.length>2&&!generic.has(w)));}
function overlap(a,b){return [...a].filter(x=>b.has(x));}
function places(item){const text=' '+words((item.context?.location||'')+' '+item.title).join(' ')+' ';return cities.filter(c=>text.includes(' '+c+' ')&&!(c==='monterey'&&text.includes('monterey county')));}
function specificPlace(item){let text=' '+words(item.context?.location).join(' ')+' ';for(const c of cities)text=text.replaceAll(' '+c+' ',' ');return new Set(words(text).filter(w=>!generic.has(w)&&w.length>2));}
function eventKind(item){const text=words(item.title+' '+item.excerpt).join(' ');return ['crash|collision|wreck','shooting|gunfire|shot','fire|burning','protest|demonstration','ice|immigration','missing|disappeared','robbery|burglary'].find(k=>new RegExp('\\b('+k+')\\b').test(text));}
function sourceKey(url){try{const u=new URL(url);if(u.protocol!=='https:')return null;
 // A profile, map, inbox or rolling agency feed is not an incident identity.
 if(/(^|\.)(google\.com|goo\.gl|maps\.apple\.com)$/.test(u.hostname))return null;
 if(/facebook\.com$/.test(u.hostname)&&!(/\/(posts|videos|permalink)\//.test(u.pathname)||u.searchParams.has('story_fbid')))return null;
 if(u.pathname.split('/').filter(Boolean).length<2&&!u.searchParams.has('story_fbid'))return null;
 for(const key of [...u.searchParams.keys()])if(/^(utm_|fbclid|igsh)/.test(key))u.searchParams.delete(key);
 u.hash='';return u.href.replace(/\/$/,'');}catch{return null;}}
function cases(item){return (String(item.title+' '+item.excerpt).match(/\b(?:case|incident|cad)\s*(?:number|no\.?|#|:)\s*[a-z0-9]*\d[a-z0-9-]{3,}/gi)||[]).map(x=>words(x.replace(/\b(number|no)\b/gi,'')).join(''));}
function compatible(a,b){const x=places(a),y=places(b);return !x.length||!y.length||x.some(c=>y.includes(c));}
function fingerprint(text){const w=words(text);return w.length>=20?sha(w.join(' ')):null;}
function repeat(a,b){if(!compatible(a,b))return null;
 const link=sourceKey(a.url);if(link&&link===sourceKey(b.url))return 'Same original source';
 for(const [key,label] of [['mediaFingerprint','Same image fingerprint'],['textFingerprint','Repeated source wording']])if(a.context?.[key]&&a.context[key]===b.context?.[key])return label;
 return null;
}
function match(a,b){
 if(!compatible(a,b))return null;
 const duplicate=repeat(a,b);if(duplicate)return {score:100,reason:duplicate,repeated:true};
 const x=cases(a),y=cases(b);if(x.some(c=>y.includes(c))&&places(a).some(c=>places(b).includes(c)))return {score:95,reason:'Same incident reference',repeated:false};
 const at=Date.parse(a.receivedAt),bt=Date.parse(b.receivedAt);
 if(!Number.isFinite(at)||!Number.isFinite(bt)||Math.abs(at-bt)>24*3600000)return null;
 const ea=Date.parse(a.context?.eventAt),eb=Date.parse(b.context?.eventAt);
 if(Number.isFinite(ea)&&Number.isFinite(eb)&&Math.abs(ea-eb)>8*3600000)return null;
 const ap=specificPlace(a),bp=specificPlace(b),shared=overlap(ap,bp);
 if(shared.length<2||ap.size<2||bp.size<2||shared.length/Math.max(ap.size,bp.size)<0.67)return null;
 if(!eventKind(a)||eventKind(a)!==eventKind(b))return null;
 const title=overlap(terms(a.title),terms(b.title));
 if(title.length<2)return null;
 return {score:70+Math.min(title.length,10),reason:'Matching place and incident details within 24 hours',repeated:false};
}
module.exports={sha,match,repeat,fingerprint,sourceKey};
