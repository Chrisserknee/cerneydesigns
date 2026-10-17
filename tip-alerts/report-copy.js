'use strict';
(function(root){
 function appendReportCopy(tip,parent){
  for(const [key,title,label,max] of [['instagramDescription','Instagram description','Copy Instagram caption',2100],['voiceover','VO script','Copy VO',6000]]){
   const value=tip[key];if(typeof value!=='string'||!value.trim()||value.length>max)continue;
   const section=document.createElement('details');section.className='report-copy';
   const summary=document.createElement('summary');summary.textContent=title;
   const area=document.createElement('textarea');area.readOnly=true;area.value=value;area.rows=6;area.setAttribute('aria-label',title);area.spellcheck=false;
   const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=label;
   const status=document.createElement('span');status.className='copy-status';status.setAttribute('role','status');
   button.addEventListener('click',async()=>{
    try{
     if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
     await navigator.clipboard.writeText(value);status.textContent='Copied';
    }catch{
     section.open=true;area.focus();area.select();area.setSelectionRange(0,value.length);
     let copied=false;try{copied=document.execCommand('copy');}catch{}
     status.textContent=copied?'Copied':'Text selected. Choose Copy.';
    }
   });
   const actions=document.createElement('div');actions.className='copy-actions';actions.append(button,status);
   section.append(summary,area,actions);parent.append(section);
  }
 }
 root.CerneyReportCopy={appendReportCopy};
 if(typeof module!=='undefined')module.exports={appendReportCopy};
})(typeof window==='undefined'?globalThis:window);
