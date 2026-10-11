'use strict';
const {createHash}=require('node:crypto');
const {driveUrl}=require('./tip-alerts-helpers');
function reportDelivery(tip,report,delivery){
 if(!delivery || delivery.version!==1 || delivery.draftDelivered!==true || delivery.source!==tip.path || delivery.id!==tip.id
    || String(delivery.sourceGeneration)!==String(tip.sourceGeneration)
    || delivery.id!==createHash('sha256').update(tip.path).digest('hex')
    || delivery.jobId!==createHash('sha256').update(`tip-line-8c2d7.firebasestorage.app/${tip.path}#${tip.sourceGeneration}`).digest('hex').slice(0,20)
    || !['ready','approved','needs_review'].includes(delivery.state)
    || !report || !['ready','approved','needs_review'].includes(report.state)
    || delivery.revision!==report.revision || !Number.isSafeInteger(delivery.revision) || delivery.revision<1
    || !Number.isFinite(Date.parse(delivery.updatedAt)))return null;
 return driveUrl(delivery.driveUrl);
}
module.exports={reportDelivery};
