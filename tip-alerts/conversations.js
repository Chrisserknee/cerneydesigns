'use strict';
(function(root){
 const text=t=>t.submission?.text||t.sourceText||t.summary||'';
 function groups(tips){
  const ordered=[...tips].sort((a,b)=>Date.parse(a.receivedAt)-Date.parse(b.receivedAt)||a.id.localeCompare(b.id)),result=[],active=new Map();
  for(const tip of ordered){
   const identity=tip.sourceKind==='google_voice'&&/^[a-f0-9]{64}$/.test(tip.conversationID||'')?tip.conversationID:null;
   const prior=identity&&active.get(identity),last=prior?.at(-1);
   if(prior&&prior.length<100&&Date.parse(tip.receivedAt)-Date.parse(last.receivedAt)<=6*3600000&&Date.parse(tip.receivedAt)-Date.parse(prior[0].receivedAt)<=24*3600000)prior.push(tip);
   else{const value=[tip];result.push(value);if(identity)active.set(identity,value);}
  }
  return result.map(messages=>({id:messages[0].id,messages,latest:messages.at(-1),context:messages.find(t=>text(t).length>=50)||messages.reduce((a,b)=>text(a).length>=text(b).length?a:b)})).sort((a,b)=>Date.parse(b.latest.receivedAt)-Date.parse(a.latest.receivedAt)||a.id.localeCompare(b.id));
 }
 const api={groups,text};if(typeof module==='object')module.exports=api;else root.CerneyConversations=api;
})(globalThis);
