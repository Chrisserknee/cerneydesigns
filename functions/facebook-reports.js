'use strict';
const registry=require('./facebook-sources.json');
const sources=new Map(registry.sources.map(s=>[s.id,s]));
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const text=(x,n)=>typeof x==='string'?x.trim().slice(0,n):'';
function safeURL(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port?u:null;}catch{return null;}}
function matches(source,value){
 const u=safeURL(value);if(!u)return false;
 if(source.channel==='official_website'){const root=new URL(source.url);return u.hostname===root.hostname&&(root.pathname==='/'||u.pathname===root.pathname||u.pathname.startsWith(root.pathname.replace(/\/$/,'')+'/'));}
 if(!['www.facebook.com','facebook.com','m.facebook.com'].includes(u.hostname))return false;
 const parts=u.pathname.toLowerCase().split('/').filter(Boolean);
 if(parts[0]==='groups')return source.aliases.includes('groups/'+parts[1]);
 if(['profile.php','permalink.php','story.php','photo.php'].includes(parts[0]))return source.aliases.includes(u.searchParams.get('id'));
 if(parts[0]==='people')return source.aliases.includes(parts[2]);
 if(parts[0]==='p')return source.aliases.includes(parts[1])||source.aliases.includes(parts[1]?.split('-').at(-1));
 return source.aliases.includes(parts[0]);
}
function sourceFor(value){return registry.sources.find(s=>matches(s,value));}
function facebookDetails(record){
 const f=record?.facebook;if(!f||f.version!==2)return null;
 const source=sources.get(f.sourceID);
 if(!source||!matches(source,f.pageURL)||!['notable','important','urgent'].includes(f.significance)||!text(f.significanceReason,500))return null;
 const urls=(record.sources||[]).map(s=>s.url);
 // Standalone reels/photo links need the collector's verified page identity.
 if(!urls.some(x=>{const u=safeURL(x);return matches(source,x)||(source.channel==='facebook'&&u&&['www.facebook.com','facebook.com'].includes(u.hostname)&&(/^\/(reel|watch|photo|photos)\//.test(u.pathname)||u.pathname==='/photo.php'));}))return null;
 const publishedAt=iso(f.publishedAt)&&Date.parse(f.publishedAt)<=Date.parse(record.observedAt)+60000?f.publishedAt:null;
 let outreach=null;const o=f.outreach;
 if(f.resolved!==true&&o&&o.eligible===true&&iso(o.expiresAt)&&iso(o.anchorAt)&&Date.parse(o.expiresAt)>Date.parse(o.anchorAt)&&Date.parse(o.expiresAt)<=Date.parse(o.anchorAt)+48*3600000&&/^[a-f0-9]{64}$/.test(o.id||'')&&text(o.headline,100)===o.headline&&o.headline.length>=8&&o.headline.toLowerCase().startsWith('reported ')&&text(record.location,120)&&o.headline.toLowerCase().includes(record.location.toLowerCase())&&Date.parse(o.anchorAt)<=Date.parse(record.observedAt)+60000){
  outreach={eligible:true,id:o.id,headline:o.headline,anchorAt:o.anchorAt,expiresAt:o.expiresAt,category:text(o.category,40)};
 }
 return {version:2,sourceID:source.id,sourceName:source.name,sourceKind:source.kind,channel:source.channel,pageURL:source.url,publishedAt,publishedTimeLabel:text(f.publishedTimeLabel,100),significance:f.significance,significanceReason:text(f.significanceReason,500),category:text(f.category,40),incidentID:/^[a-f0-9]{64}$/.test(f.incidentID||'')?f.incidentID:outreach?.id||null,resolved:f.resolved===true,outreach};
}
function approvedReport(record){return !!facebookDetails(record)||(record?.sources||[]).some(s=>sourceFor(s.url));}
function monitorStatus(value){
 if(!value||value.version!==1||!iso(value.checkedAt))return null;
 const count=x=>Number.isSafeInteger(x)&&x>=0&&x<=1000?x:0;
 return {version:1,checkedAt:value.checkedAt,status:['partial','blocked','complete'].includes(value.status)?value.status:'partial',sourcesChecked:count(value.sourcesChecked),sourceCount:registry.sources.length,reportsSaved:count(value.reportsSaved)};
}
module.exports={registry,sources,safeURL,matches,sourceFor,facebookDetails,approvedReport,monitorStatus};
