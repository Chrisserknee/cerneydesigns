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
 // Beveled seven-segment geometry is shared with the native renderer.
 const SEGMENTS={'0':'abcdef','1':'bc','2':'abged','3':'abgcd','4':'fgbc','5':'afgcd','6':'afgecd','7':'abc','8':'abcdefg','9':'abfgcd','-':'g'};
 function segmentShapes(value,x,y){
  const horizontal=(yy)=>[[8,yy],[46,yy],[51,yy+5],[46,yy+10],[8,yy+10],[3,yy+5]];
  const vertical=(xx,yy)=>[[xx+4.5,yy],[xx+9,yy+4.5],[xx+9,yy+29.5],[xx+4.5,yy+34],[xx,yy+29.5],[xx,yy+4.5]];
  const shapes={a:horizontal(0),b:vertical(45,8),c:vertical(45,52),d:horizontal(84),e:vertical(0,52),f:vertical(0,8),g:horizontal(42)};
  const result=[];
  for(const digit of value){
   if(digit===':'){
    for(const yy of [29,65])result.push({on:true,points:[[4,yy],[10,yy],[12,yy+2],[12,yy+8],[10,yy+10],[4,yy+10],[2,yy+8],[2,yy+2]].map(([px,py])=>[x+px,y+py])});x+=27;continue;
   }
   for(const [key,points]of Object.entries(shapes))result.push({on:Boolean(SEGMENTS[digit]?.includes(key)),points:points.map(([px,py])=>[x+px,y+py])});x+=69;
  }
  return result;
 }
 function path(c,shapes){c.beginPath();for(const shape of shapes){shape.points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();}}
 function clock(c,value,x,y){
  const shapes=segmentShapes(value,x,y),lit=shapes.filter(s=>s.on);
  c.save();path(c,shapes);c.fillStyle='rgba(255,65,67,.045)';c.fill();
  // Broad bloom, tight bloom, and luminous core remain separate so the segments stay sharp.
  for(const [blur,alpha,shadow]of [[28,.12,.50],[10,.44,.75]]){
   c.save();path(c,lit);c.fillStyle=`rgba(255,42,52,${alpha})`;c.shadowColor=`rgba(255,36,48,${shadow})`;c.shadowBlur=blur;c.fill();c.restore();
  }
  const core=c.createLinearGradient(0,y,0,y+94);core.addColorStop(0,'rgba(255,221,202,.94)');core.addColorStop(.16,'rgba(255,116,109,.94)');core.addColorStop(.52,'rgba(255,75,83,.93)');core.addColorStop(1,'rgba(255,49,67,.91)');
  path(c,lit);c.fillStyle=core;c.shadowColor='rgba(255,52,61,.65)';c.shadowBlur=3;c.fill();c.shadowBlur=0;c.strokeStyle='rgba(255,215,199,.32)';c.lineWidth=.65;c.stroke();
  // Fine, deterministic phosphor imperfections only inside the illuminated segments.
  c.save();path(c,lit);c.clip();c.fillStyle='rgba(44,4,13,.20)';
  for(let row=0;row<94;row+=4)c.fillRect(x,y+row,300,.65);
  for(let i=0;i<420;i++){const px=(i*73.37)%300,py=(i*31.73)%94;c.fillStyle=i%3?'rgba(45,3,12,.17)':'rgba(255,236,211,.25)';c.fillRect(x+px,y+py,.7+(i%3)*.2,.7);}
  c.restore();
  // Restrained diffraction streaks from the two colon emitters, not a full-frame blur.
  const cx=x+145;
  c.globalCompositeOperation='screen';
  for(const yy of [y+34,y+70]){const flare=c.createLinearGradient(cx-48,yy,cx+48,yy);flare.addColorStop(0,'rgba(255,62,63,0)');flare.addColorStop(.5,'rgba(255,177,140,.30)');flare.addColorStop(1,'rgba(255,62,63,0)');c.fillStyle=flare;c.fillRect(cx-48,yy,96,1);c.fillStyle='rgba(255,116,99,.13)';c.fillRect(cx,yy-16,.8,32);}
  c.restore();
 }
 function draw(c,story){
  c.save();
  function text(value,x,y,size,color,mono=false){c.save();c.fillStyle=color;c.font=`${mono?'400':'600'} ${size}px ${mono?'"Cerney Digital", Menlo, monospace':'Arial, sans-serif'}`;if(mono){c.letterSpacing='1px';c.shadowColor=color;c.shadowBlur=4;}c.fillText(value,x,y+size);c.restore();}
  c.fillStyle='rgba(196,211,221,.32)';
  for(const [x,y,dx,dy]of [[62,204,1,1],[1018,204,-1,1],[62,1700,1,-1],[1018,1700,-1,-1]]){c.fillRect(dx>0?x:x-26,y,26,2);c.fillRect(x,dy>0?y:y-26,2,26);}
  c.fillStyle=RED;c.fillRect(86,242,38,6);text(story.basis==='demo'?'DESIGN EXAMPLE · NO REAL INCIDENT':'LOCAL REPORT',142,228,28,'#fff');
  // Smoked glass transmits the selected photograph; reflections stay quiet behind the readout.
  const glass=c.createLinearGradient(86,320,994,532);glass.addColorStop(0,'rgba(5,11,17,.66)');glass.addColorStop(.48,'rgba(9,16,23,.38)');glass.addColorStop(1,'rgba(5,10,16,.58)');c.fillStyle=glass;c.fillRect(86,320,908,212);
  c.strokeStyle='rgba(255,104,105,.25)';c.lineWidth=1;c.strokeRect(86,320,908,212);
  const reflection=c.createLinearGradient(86,320,86,390);reflection.addColorStop(0,'rgba(214,230,240,.065)');reflection.addColorStop(1,'rgba(214,230,240,0)');c.fillStyle=reflection;c.fillRect(87,321,906,69);
  c.fillStyle='rgba(216,227,238,.15)';c.fillRect(87,320,906,1);c.fillStyle='rgba(255,83,83,.70)';c.fillRect(86,320,3,212);
  const t=timing(story);text(t.label,116,342,21,'#d5a8a2',true);clock(c,t.digits,116,394);text(t.period,435,454,27,'#ff8c83',true);text(t.dateLine,601,395,26,'#e5cec1',true);text('PACIFIC'+(t.zone?' · '+t.zone:''),601,445,20,'#b3c4cc',true);
  c.fillStyle='rgba(255,255,255,.28)';c.fillRect(86,1120,908,1);c.fillStyle=RED;c.fillRect(86,1120,140,4);text('PHOTOS / VIDEO',86,1160,24,'#bac5d1',true);
  c.fillStyle='rgba(255,255,255,.25)';c.fillRect(86,1656,908,1);for(let i=0;i<13;i++)c.fillRect(86+i*10,1666,4,i%3===0?12:6);
  c.restore();
 }
 root.CerneyStoryClock={timing,draw,segmentShapes};if(typeof module!=='undefined')module.exports=root.CerneyStoryClock;
})(typeof window==='undefined'?globalThis:window);
