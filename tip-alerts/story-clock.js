'use strict';
(function(root){
 const RED='#ff5353';
 function validDate(value){return typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value):null;}
 function timing(story){
  const receipt=validDate(story.reportReceivedAt),date=receipt||validDate(story.createdAt);
  const label=story.basis==='demo'?'EXAMPLE TIME':receipt?'REPORT RECEIVED':'DRAFT PREPARED';
  if(!date)return {label,digits:'--:--',period:'',dateLine:'TIME UNAVAILABLE',zone:''};
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'2-digit',minute:'2-digit',hour12:true,month:'short',day:'2-digit',year:'numeric',timeZoneName:'short'}).formatToParts(date).map(p=>[p.type,p.value]));
  return {label,digits:p.hour+':'+p.minute,period:p.dayPeriod,dateLine:(p.month+' '+p.day+', '+p.year).toUpperCase(),zone:p.timeZoneName};
 }
 function draw(c,story){
  c.save();
  function text(value,x,y,size,color,mono=false){c.fillStyle=color;c.font=`600 ${size}px ${mono?'Menlo, Consolas, monospace':'Arial, sans-serif'}`;c.fillText(value,x,y+size);}
  c.fillStyle=RED;c.fillRect(86,242,38,6);
  text(story.basis==='demo'?'DESIGN EXAMPLE · NO REAL INCIDENT':'LOCAL REPORT',142,228,28,'#fff');
  c.fillStyle='rgba(11,20,29,.90)';c.fillRect(86,320,908,196);c.strokeStyle='rgba(255,83,83,.55)';c.lineWidth=1;c.strokeRect(86,320,908,196);c.fillStyle=RED;c.fillRect(86,320,4,196);
  const t=timing(story);text(t.label,116,343,21,'#c3c9d0');clock(c,t.digits,116,396);text(t.period,416,443,28,RED,true);text(t.dateLine,613,397,27,'#fff',true);text('PACIFIC'+(t.zone?' · '+t.zone:''),613,444,21,'#aab5c0',true);
  c.fillStyle='rgba(255,255,255,.28)';c.fillRect(86,1120,908,1);c.fillStyle=RED;c.fillRect(86,1120,140,4);text('PHOTOS / VIDEO',86,1160,24,'#bac5d1',true);
  c.fillStyle='rgba(255,255,255,.25)';c.fillRect(86,1656,908,1);for(let i=0;i<13;i++)c.fillRect(86+i*10,1666,4,i%3===0?12:6);
  c.restore();
 }
 function clock(c,value,x,y){
  const segments={'0':'abcdef','1':'bc','2':'abged','3':'abgcd','4':'fgbc','5':'afgcd','6':'afgecd','7':'abc','8':'abcdefg','9':'abfgcd','-':'g'};
  const rects=[['a',7,0,34,6],['b',42,7,6,30],['c',42,45,6,30],['d',7,76,34,6],['e',0,45,6,30],['f',0,7,6,30],['g',7,38,34,6]];
  for(const digit of value){if(digit===':'){c.fillStyle=RED;c.fillRect(x+2,y+24,6,6);c.fillRect(x+2,y+52,6,6);x+=24;continue;}
   for(const [key,dx,dy,w,h] of rects){const on=segments[digit]?.includes(key);c.save();c.fillStyle=on?RED:'rgba(255,83,83,.07)';if(on){c.shadowColor='rgba(255,83,83,.3)';c.shadowBlur=5;}c.fillRect(x+dx,y+dy,w,h);c.restore();}x+=62;
  }
 }
 root.CerneyStoryClock={timing,draw};if(typeof module!=='undefined')module.exports=root.CerneyStoryClock;
})(typeof window==='undefined'?globalThis:window);
