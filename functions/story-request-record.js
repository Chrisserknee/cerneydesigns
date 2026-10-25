'use strict';
const ID=/^[a-f0-9]{64}$/;
const clean=(v,max)=>typeof v==='string' && v.length<=max ? v.replace(/[\u0000-\u001f\u007f]/g,' ').trim() : '';
function storyRequest(data,now=Date.now()) {
 if(!data || data.version!==1 || !ID.test(data.id||'') || data.state!=='draft'
   || !Number.isSafeInteger(data.revision) || data.revision<1 || data.revision>1000
   || !Number.isFinite(Date.parse(data.createdAt)) || !Number.isFinite(Date.parse(data.updatedAt))
   || Date.parse(data.updatedAt)>now+60000 || Date.parse(data.updatedAt)<Date.parse(data.createdAt)
   || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt)<=now
   || Date.parse(data.expiresAt)>Date.parse(data.createdAt)+48*3600000
   || !['reported','official','demo'].includes(data.basis)
   || !clean(data.headline,100) || !clean(data.question,260) || !clean(data.location,120)
   || !Array.isArray(data.sources) || !data.sources.length || data.sources.length>12)return null;
 const sources=data.sources.map(s=>({label:clean(s.label,100),kind:clean(s.kind,30),tipId:ID.test(s.tipId||'')?s.tipId:null}));
 if(sources.some(s=>!s.label))return null;
 return {version:1,id:data.id,state:'draft',revision:data.revision,createdAt:data.createdAt,updatedAt:data.updatedAt,expiresAt:data.expiresAt,
  headline:clean(data.headline,100),question:clean(data.question,260),context:clean(data.context,200),location:clean(data.location,120),
  timeLabel:clean(data.timeLabel,70),basis:data.basis,reviewNote:clean(data.reviewNote,800),sources,
  urgency:['community','developing','urgent','critical','update'].includes(data.urgency)?data.urgency:null,category:data.category==='police'?'police':null,
  callToAction:'Have photos or video? Upload them to my tipline or send them directly to me.',uploadUrl:'https://www.chriscerney.org/upload',
  notify:data.notify===true && data.basis!=='demo'};
}
function storyMonitor(data){
 if(data?.version!==1 || !Number.isFinite(Date.parse(data.checkedAt)))return null;
 const count=v=>Number.isSafeInteger(v)&&v>=0?v:0;
 return {checkedAt:data.checkedAt,startedAt:data.startedAt,status:Date.now()-Date.parse(data.checkedAt)>180000?'attention':['healthy','attention'].includes(data.status)?data.status:'unknown',
  pending:count(data.pending),reviewCount:count(data.reviewCount),reviewTipIDs:(Array.isArray(data.reviewTipIDs)?data.reviewTipIDs:[]).filter(x=>ID.test(x)).slice(0,30),drafts:count(data.drafts),held:count(data.held),lastCrossCheckAt:Number.isFinite(Date.parse(data.lastCrossCheckAt))?data.lastCrossCheckAt:null};
}
module.exports={storyRequest,storyMonitor};
