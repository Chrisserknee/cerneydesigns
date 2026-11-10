'use strict';
// Owner-only controls; server validation is authoritative.
window.BookingScheduleEditor=class {
 constructor(root){this.root=root;}
 node(tag,text){const e=document.createElement(tag);if(text)e.textContent=text;return e;}
 field(label,type,value){const wrap=this.node('label',label),input=this.node('input');input.type=type;input.value=value??'';wrap.append(input);return {wrap,input};}
 render(c){
  this.root.replaceChildren();this.root.className='schedule-editor';
  this.root.append(this.node('h3','Your available filming dates'),this.node('p','Only the hours you open can be requested. Busy times on connected Google calendars and approved booking holds are removed automatically. All times use '+c.timeZone+'.'));
  const modeLabel=this.node('label','Availability'),mode=this.node('select');mode.id='availabilityMode';
  for(const [value,label] of [['dates','Only dates I choose'],['weekly','Repeat my weekly hours']])mode.add(new Option(label,value));mode.value=c.availabilityMode||'weekly';modeLabel.append(mode);this.mode=mode;this.root.append(modeLabel);
  this.weekly=this.node('div');this.weekly.className='weekly-hours';this.days=[];
  for(const [day,name] of ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].entries()){
   const row=this.node('div'),label=this.node('label',name),check=this.node('input');row.className='schedule-row';check.type='checkbox';const w=(c.weeklyWindows||[]).find(w=>w.day===day);check.checked=!!w;label.prepend(check);
   const start=this.field('From','time',w?.start||'09:00'),end=this.field('Until','time',w?.end||'17:00');start.input.setAttribute('aria-label',name+' start');end.input.setAttribute('aria-label',name+' end');
   row.append(label,start.wrap,end.wrap);this.weekly.append(row);this.days.push({day,check,start:start.input,end:end.input});
  }
  this.root.append(this.weekly);mode.onchange=()=>{this.weekly.hidden=mode.value!=='weekly';};mode.onchange();
  this.root.append(this.node('h4','Specific dates'),this.node('p','Add the dates you want to offer. In weekly mode, these override the usual hours for that date. Mark a date closed to take it off.'));
  this.dates=this.node('div');this.rows=[];this.root.append(this.dates);for(const w of c.windows||[])this.addDate(w);
  const add=this.node('button','Add available date');add.type='button';add.className='secondary';add.id='addAvailableDate';add.onclick=()=>this.addDate({});this.root.append(add);
  const limits=this.node('div');limits.className='two';this.limits={};
  for(const [key,label,min,max,fallback] of [['bookingHorizonDays','Show dates up to this many days ahead',7,365,60],['leadHours','Minimum notice (hours)',0,168,24],['bufferBefore','Travel / preparation before (minutes)',0,168,30],['bufferAfter','Time after filming (minutes)',0,168,30]]){const f=this.field(label,'number',c[key]??fallback);f.input.min=min;f.input.max=max;f.input.step=1;f.input.required=true;f.input.name=key;limits.append(f.wrap);this.limits[key]=f.input;}this.root.append(limits);
 }
 addDate(w){
  const row=this.node('div');row.className='date-row';const date=this.field('Date','date',w.date),start=this.field('From','time',w.start||'09:00'),end=this.field('Until','time',w.end||'17:00');date.input.required=true;
  const label=this.node('label','Closed'),closed=this.node('input');closed.type='checkbox';closed.checked=!!w.closed;label.prepend(closed);
  const remove=this.node('button','Remove');remove.type='button';remove.className='secondary';const state={row,date:date.input,start:start.input,end:end.input,closed};
  closed.onchange=()=>{start.input.disabled=end.input.disabled=closed.checked;start.input.required=end.input.required=!closed.checked;};closed.onchange();
  remove.onclick=()=>{row.remove();this.rows=this.rows.filter(r=>r!==state);};row.append(date.wrap,start.wrap,end.wrap,label,remove);this.dates.append(row);this.rows.push(state);
 }
 apply(config){return {...config,availabilityMode:this.mode.value,weeklyWindows:this.mode.value==='weekly'?this.days.filter(d=>d.check.checked).map(d=>({day:d.day,start:d.start.value,end:d.end.value})):[],windows:this.rows.map(r=>r.closed.checked?{date:r.date.value,closed:true}:{date:r.date.value,start:r.start.value,end:r.end.value}),...Object.fromEntries(Object.entries(this.limits).map(([k,input])=>[k,Number(input.value)]))};}
};
