'use strict';
const {createHash}=require('node:crypto');
const {driveUrl}=require('./tip-alerts-helpers');
const {reportCopy}=require('./report-copy');
const clean=(v,n)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n):'';
function incidentRecord(data){
    if(!data || data.version!==1 || !/^incident:[a-f0-9]{20}:e[1-9][0-9]*$/.test(data.source||''))return null;
    const hash=x=>createHash('sha256').update(x).digest('hex');
    const [,iid,edition]=/^incident:([a-f0-9]{20}):e([1-9][0-9]*)$/.exec(data.source);
    if(data.id!==hash(data.source) || data.jobId!==hash(JSON.stringify(data.source)).slice(0,20)
       || data.incidentId!==iid || data.edition!==Number(edition) || !Number.isSafeInteger(data.revision) || data.revision<1
       || !['ready','approved','needs_review'].includes(data.state) || data.draftDelivered!==true
       || !Number.isFinite(Date.parse(data.receivedAt)) || !Number.isFinite(Date.parse(data.updatedAt))
       || !driveUrl(data.driveUrl) || !clean(data.title,100))return null;
    return {id:data.id,receivedAt:data.receivedAt,type:'incident',status:data.state==='needs_review'?'review':'ready',
        title:clean(data.title,100),summary:clean(data.summary,420),location:clean(data.location,140),
        contextSource:'claude',reportState:data.state,reportRevision:data.revision,reportEdition:data.edition,
        ...reportCopy(data),contextUpdatedAt:data.updatedAt,driveUrl:driveUrl(data.driveUrl),incomplete:false,draftDelivered:true};
}
module.exports={incidentRecord};
