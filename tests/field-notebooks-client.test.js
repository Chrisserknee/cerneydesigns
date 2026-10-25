'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{webcrypto}=require('node:crypto');
function client(respond){
 const elements=[],events={},timers=new Map();let timerID=0;
 function el(tag){const e={tag,children:[],handlers:{},attrs:{},value:'',isConnected:true,textContent:'',append(...v){for(const c of v){if(c&&typeof c==='object')c.parent=this;this.children.push(c);}},replaceChildren(...v){this.children=[];this.append(...v);},replaceWith(...v){const p=this.parent,index=p.children.indexOf(this);p.children.splice(index,1,...v);},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,v){this.handlers[k]=v;},scrollIntoView(){},remove(){this.isConnected=false;},click(){return this.handlers.click?.();}};elements.push(e);return e;}
 const root=el('main'),heading=el('h1');heading.after=e=>root.append(e);
 const context=vm.createContext({document:{createElement:el,getElementById:id=>elements.find(e=>e.id===id&&e.isConnected),querySelector:()=>heading},window:{addEventListener:(k,f)=>events[k]=f},location:{search:''},URL,URLSearchParams,Date,Blob,Uint8Array,TextEncoder,crypto:webcrypto,confirm:()=>true,navigator:{mediaDevices:{getUserMedia:()=>{throw Error('Microphone must not start during these tests');}}},atob:s=>Buffer.from(s,'base64').toString('binary'),btoa:s=>Buffer.from(s,'binary').toString('base64'),setInterval:()=>1,clearInterval(){},setTimeout:(fn,ms)=>{timers.set(++timerID,{fn,ms});return timerID;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(fs.readFileSync(__dirname+'/../tip-alerts/newsroom.js','utf8'),context);
 const api=async(op,p={})=>respond(op,p);
 return {app:context.CerneyNewsroom,elements,events,timers,api,button:text=>elements.find(e=>e.tag==='button'&&e.textContent===text),field:label=>elements.filter(e=>e.attrs['aria-label']===label).at(-1),runTimer:async()=>{const entry=[...timers.entries()].find(([,v])=>v.ms===1200);if(entry){timers.delete(entry[0]);await entry[1].fn();}}};
}
function fixture(){let note=null;const calls=[];const c=client(async(op,p)=>{calls.push({op,...p});if(op==='newsroom')return {alerts:[],notes:[]};if(op==='field-save'){note=structuredClone(p.note);return {note};}if(op==='field-get')return {note};throw Error('Unexpected operation');});return {c,calls,get note(){return note;}};}
test('a text notebook preserves linked evidence and needs no microphone or audio upload',async()=>{
 const f=fixture();await f.c.app.refresh(f.c.api);const evidence=[{id:'b'.repeat(64),title:'Source claim',excerpt:'Unverified report',kind:'community_tip'}];await f.c.app.startStory({title:'Reporting notebook',evidence});
 assert.equal(f.note.title,'Reporting notebook');assert.equal(f.note.evidence[0].excerpt,'Unverified report');assert.equal(f.note.transcript,'');assert(!f.calls.some(x=>x.op.startsWith('field-audio')));assert.equal(f.c.app.hasUnsavedWork(),false);
});
test('typing auto saves a new revision without changing source evidence or transcript',async()=>{
 const f=fixture();await f.c.app.refresh(f.c.api);await f.c.app.startStory({title:'Notebook',evidence:[{id:'b'.repeat(64),title:'Source',excerpt:'Unverified words'}]});const input=f.c.field('Reporting notes');input.value='What still needs checking: event time.';input.handlers.input();assert.equal(f.c.app.hasUnsavedWork(),true);await f.c.runTimer();assert.equal(f.note.notes,input.value);assert.equal(f.note.revision,2);assert.equal(f.note.evidence[0].excerpt,'Unverified words');assert.equal(f.c.app.hasUnsavedWork(),false);
});
test('failed autosave keeps edits and warns before closing instead of discarding them',async()=>{
 let note,fail=false;const c=client(async(op,p)=>{if(op==='newsroom')return {alerts:[],notes:[]};if(op==='field-get')return {note};if(op==='field-save'){if(fail)throw Error('Offline');note=structuredClone(p.note);return {note};}});await c.app.refresh(c.api);await c.app.startStory({title:'Notebook'});fail=true;const field=c.field('Story draft');field.value='Unsaved important reporting';field.handlers.input();await c.runTimer();assert.equal(c.app.hasUnsavedWork(),true);assert.equal(field.value,'Unsaved important reporting');let prevented=false;c.events.beforeunload({preventDefault(){prevented=true;}});assert(prevented);assert.equal(note.draft,'');
});
test('source excerpts are rendered as text and AI development retains them',async()=>{
 const f=fixture();await f.c.app.refresh(f.c.api);await f.c.app.startStory({title:'Notebook',evidence:[{id:'b'.repeat(64),title:'Source',excerpt:'<img src=x onerror=alert(1)>',url:'javascript:alert(1)'}]});await f.c.button('Develop story with AI').click();assert.equal(f.note.processRequested,true);assert.equal(f.note.evidence[0].excerpt,'<img src=x onerror=alert(1)>');assert(!f.c.elements.some(e=>e.href==='javascript:alert(1)'));assert(f.c.elements.some(e=>e.tag==='p'&&e.textContent==='<img src=x onerror=alert(1)>'));
});
