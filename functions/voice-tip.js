'use strict';
function voiceTip(record){
 return !!record && record.sourceKind==='google_voice' && /^[a-f0-9]{64}$/.test(record.id||'')
  && record.path===`_tipalerts/v1/voice-sources/${record.id}.json`
  && typeof record.sourceDescription==='string' && record.sourceDescription.length<=6000
  && Number.isFinite(Date.parse(record.receivedAt)) && ['ready','review'].includes(record.status);
}
function refreshFromStored(record,refreshSource){
 return voiceTip(record) || (typeof record?.sourceDescription==='string' && refreshSource!==true);
}
function voiceMonitor(record,now=Date.now()){
 if(record?.version!==1)return null;
 const recent=Number.isFinite(Date.parse(record.lastSuccessfulCheckAt)) && now-Date.parse(record.lastSuccessfulCheckAt)<120000;
 return {checkedAt:record.checkedAt,lastSuccessfulCheckAt:record.lastSuccessfulCheckAt,
  status:recent&&record.status==='healthy'?'healthy':'attention',
  pending:Number.isSafeInteger(record.pending)?record.pending:0,syncPending:Number.isSafeInteger(record.syncPending)?record.syncPending:0,
  imported:Number.isSafeInteger(record.imported)?record.imported:0,pollSeconds:20};
}
module.exports={voiceTip,refreshFromStored,voiceMonitor};
