(function(root){
 'use strict';
 const labels={'facebook-groups':'Facebook groups','official-pages':'Official agency pages'};
 const statuses={healthy:'Checked',scheduled:'On schedule',waiting:'Waiting for check',paused:'Paused',blocked:'Check blocked',stale:'No recent report',partial:'Coverage incomplete',overdue:'Check overdue',unknown:'Not confirmed',unavailable:'Status unavailable'};
 const attention=new Set(['blocked','stale','partial','overdue','unknown','unavailable']);
 function date(value,now){const n=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(n)&&n<=now+60000?n:null;}
 function snapshot(monitor={},now=Date.now()){
  monitor=monitor||{};
  const published=date(monitor.publishing?.publishedAt||monitor.checkedAt,now),fresh=published!==null&&now-published<=180000;
  const publishing={id:'publishing',label:'App sync',status:fresh?'healthy':'stale',stateLabel:fresh?'Connected':'Needs attention',summary:fresh?'The Mac is sending saved information to the app. This does not confirm fresh source checks.':'No recent sync from the Mac. Showing the last saved source status.',lastAttemptAt:published===null?null:new Date(published).toISOString()};
  let collectors=[];
  if(monitor.sourceHealth?.version===1&&Array.isArray(monitor.sourceHealth.collectors)){
   const seen=new Set();
   collectors=monitor.sourceHealth.collectors.filter(r=>r&&Object.hasOwn(labels,r.id)&&!seen.has(r.id)&&seen.add(r.id)).slice(0,2).map(r=>{
    const status=Object.hasOwn(statuses,r.status)?r.status:'unknown',out={id:r.id,label:labels[r.id],status,stateLabel:statuses[status],summary:typeof r.summary==='string'?r.summary.slice(0,300):''};
    for(const key of ['lastAttemptAt','lastCompleteAt','lastReceiptAt','nextScheduledAt']){const n=key==='nextScheduledAt'?Date.parse(r[key]):date(r[key],now);out[key]=Number.isFinite(n)?new Date(n).toISOString():null;}
    if(out.id==='facebook-groups'&&out.status==='healthy'&&!out.lastReceiptAt){out.status='unknown';out.stateLabel=statuses.unknown;out.summary='No valid group-check receipt has reached the app.';}
    if(out.status!=='paused'&&out.id==='facebook-groups'&&out.lastReceiptAt&&now-Date.parse(out.lastReceiptAt)>7200000){out.status='stale';out.stateLabel=statuses.stale;out.summary='No recent group-check report. Current group activity is unknown.';}
    return out;
   });
  }
  if(!collectors.length){
   const last=date(monitor.collection?.lastReportAt,now),paused=monitor.collection?.hold===true;
   const states=Array.isArray(monitor.collection?.coverage)?monitor.collection.coverage.map(x=>x?.status):[];
   const status=paused?'paused':last===null?'unknown':now-last>7200000?'stale':states.length&&states.every(x=>x==='blocked')?'blocked':states.length&&states.every(x=>x==='complete')?'healthy':'partial';
   collectors=[{id:'facebook-groups',label:labels['facebook-groups'],status,stateLabel:statuses[status],summary:'Group-check evidence is separate from the app sync.',lastReceiptAt:last===null?null:new Date(last).toISOString()}];
  }
  for(const [id,label] of Object.entries(labels)){if(!collectors.some(r=>r.id===id))collectors.push({id,label,status:'unknown',stateLabel:statuses.unknown,summary:'No source-check status has reached the app.'});}
  const needsAttention=!fresh||collectors.some(r=>attention.has(r.status));
  return {headline:!fresh?'Connection needs attention':needsAttention?'Sources need attention':collectors.every(r=>r.status==='paused')?'Source checks paused':'Source connections',needsAttention,publishing,collectors};
 }
 function render(monitor,onRefresh){
  const state=snapshot(monitor),create=(tag,text)=>{const el=document.createElement(tag);if(text)el.textContent=text;return el;};
  const box=create('details');box.className='source-health';box.dataset.attention=String(state.needsAttention);box.append(create('summary',state.headline));
  for(const row of [state.publishing,...state.collectors]){
   const item=create('section');item.className='source-health-row';const title=create('div');title.className='source-health-title';title.append(create('strong',row.label),create('span',row.stateLabel));item.append(title,create('p',row.summary));
   const stamp=(label,value)=>{if(value)item.append(create('p',label+': '+new Date(value).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})));};
   stamp(row.id==='publishing'?'Last sync':'Last attempt',row.lastAttemptAt);
   if(row.lastReceiptAt!==row.lastAttemptAt)stamp('Last report received',row.lastReceiptAt);
   stamp('Coverage through',row.lastCompleteAt);
   if(row.status!=='paused')stamp('Next scheduled slot',row.nextScheduledAt);
   box.append(item);
  }
  if(onRefresh){const button=create('button','Refresh status');button.type='button';button.addEventListener('click',async()=>{button.disabled=true;try{await onRefresh();}finally{button.disabled=false;}});box.append(button);}
  return box;
 }
 root.CerneySourceHealth={snapshot,render};if(typeof module!=='undefined')module.exports={snapshot};
})(typeof globalThis==='undefined'?window:globalThis);
