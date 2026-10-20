'use strict';
const {copyText}=require('./report-copy');
function facebookPost(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!['www.facebook.com','facebook.com'].includes(u.hostname))return '';
 if(!(/\/posts\/[^/]+/.test(u.pathname)||/\/videos\/[^/]+/.test(u.pathname)||/^\/reel\/\d+\/?$/.test(u.pathname)||(u.pathname==='/watch/'&&/^\d+$/.test(u.searchParams.get('v')||''))||(u.pathname==='/permalink.php'&&/^\d+$/.test(u.searchParams.get('story_fbid')||''))))return '';u.hash='';return u.href;}catch{return '';}
}
function videoURL(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='drive.google.com'&&!u.username&&!u.password&&!u.port&&/^\/file\/d\/[A-Za-z0-9_-]{10,200}\/view$/.test(u.pathname)?u.origin+u.pathname:'';}catch{return '';}}
function withDetails(card,data){
 if(!card||!data||data.version!==1||data.id!==card.id||data.revision!==card.reportRevision)return card;
 return {...card,videoUrl:videoURL(data.videoUrl),durationSeconds:Number.isFinite(data.durationSeconds)&&data.durationSeconds>0&&data.durationSeconds<7200?data.durationSeconds:null,sourceUrl:facebookPost(data.sourceUrl),agency:copyText(data.agency,140),county:copyText(data.county,40),sourceKind:['facebook','official_email'].includes(data.sourceKind)?data.sourceKind:'',
 publishedAt:Number.isFinite(Date.parse(data.publishedAt))?data.publishedAt:null,publicationTimeNote:copyText(data.publicationTimeNote,1200),sourceText:copyText(data.sourceText,12000),sourceTextTruncated:data.sourceTextTruncated===true,
 verificationNotes:Array.isArray(data.verificationNotes)?data.verificationNotes.slice(0,12).map(x=>copyText(x,1000)).filter(Boolean):[]};
}
function monitorHealth(data){
 if(!data||data.version!==1||!Number.isFinite(Date.parse(data.updatedAt)))return null;
 const date=v=>Number.isFinite(Date.parse(v))?v:null;const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=10000?v:0;
 const p=data.producer;const producer=p&&Number.isFinite(Date.parse(p.observedAt))?{observedAt:p.observedAt,status:['working','idle','waiting_for_desktop','waiting_for_resume'].includes(p.status)?p.status:'unknown',waitingCount:count(p.waitingCount),activeCount:count(p.activeCount),resumeCount:count(p.resumeCount),failedCount:count(p.failedCount)}:null;
 return {producer,updatedAt:data.updatedAt,lastAttemptAt:date(data.lastAttemptAt),lastCompletedAt:date(data.lastCompletedAt),agencyCount:count(data.agencyCount),pendingCount:count(data.pendingCount),collectionStatus:['blocked','catching_up','monitoring'].includes(data.collectionStatus)?data.collectionStatus:'unknown',reason:copyText(data.reason,500)};
}
module.exports={facebookPost,withDetails,monitorHealth};
