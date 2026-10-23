'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const backgrounds=require('../tip-alerts/story-backgrounds');
const storyImages=require('../tip-alerts/story-requests');
test('all eighteen cities and every catalog image are packaged',()=>{
 assert.equal(backgrounds.catalog.filter(x=>x.kind==='city').length,18);
 assert.equal(new Set(backgrounds.catalog.map(x=>x.id)).size,backgrounds.catalog.length);
 const files=[...backgrounds.catalog.map(x=>x.id),...backgrounds.styles.map(x=>'style-'+x.id),'police-lights'];
 assert.equal(files.length,93);
 for(const file of files){const bytes=fs.readFileSync(path.join(__dirname,'../tip-alerts/backgrounds/v1',file+'.jpg'));assert.deepEqual([...bytes.subarray(0,2)],[255,216]);assert(bytes.length>10000,file);}
});
test('precise community and road matching retains local specificity',()=>{
 for(const [input,id]of [['Carmel Valley Village, Monterey County','carmel-valley'],['Carmel Highlands','carmel-highlands'],['Cannery Row, Monterey','monterey-waterfront'],['Highway 68 between Salinas and Monterey','toro'],['Pebble Beach','del-monte-forest']])assert.equal(backgrounds.match(input)?.id,id,input);
});
test('broad, ambiguous and out-of-area names do not fabricate city matches',()=>{
 for(const text of ['Monterey County','Monterey Bay','Salinas River','Monterey Park','Marina del Rey','Santa Cruz County','San Benito County','Santa Cruz and Hollister','Highway 101','Salinas and Monterey','Greenfield Road'])assert.equal(backgrounds.match(text),null,text);
 assert.equal(backgrounds.suggested({location:'Unknown',headline:'Monterey reporter asks'}).locationID,'central-coast');
});
test('unverified language is not automatically promoted to critical',()=>{
 assert.notEqual(backgrounds.suggested({headline:'Immediate danger, evacuation order',basis:'reported'}).urgency,'critical');
 assert.equal(backgrounds.suggested({headline:'Evacuation order',basis:'official'}).urgency,'critical');
 assert.equal(backgrounds.suggested({headline:'Road closure',basis:'official'}).urgency,'urgent');
 assert.equal(backgrounds.suggested({headline:'Road reopened, final update',basis:'official'}).urgency,'update');
 assert.equal(backgrounds.suggested({headline:'Urgent road closure',basis:'official'}).policeLights,false);
});
test('image URLs are fixed same-origin allowlisted resources',()=>{
 const urls=backgrounds.paths({locationID:'../../private',urgency:'https://evil.example/image',policeLights:false});
 assert.deepEqual(urls,['/tip-alerts/backgrounds/v1/central-coast.jpg?v=20261023-ref1','/tip-alerts/backgrounds/v1/style-community.jpg?v=20261023-ref1']);
 assert.equal(backgrounds.paths({locationID:'monterey',urgency:'urgent',policeLights:true}).at(-1),'/tip-alerts/backgrounds/v1/police-lights.jpg?v=20261023-ref1');
});
test('images load only on request and repeat exports reuse public artwork',async()=>{
 let loads=0;
 global.Image=class{set src(value){loads++;this.naturalWidth=1080;this.naturalHeight=1920;queueMicrotask(()=>this.onload());}};
 assert.equal(loads,0);
 const look={locationID:'monterey',urgency:'community',policeLights:false};
 const [one,two]=await Promise.all([backgrounds.load(look),backgrounds.load(look)]);
 assert.equal(loads,2);assert.equal(one.images[0],two.images[0]);
 await backgrounds.load({...look,policeLights:true});assert.equal(loads,3);
 delete global.Image;
});
function recordingCanvas(){
 const calls=[],ctx={font:'',fillStyle:'',measureText(t){return {width:t.length*(Number(this.font.match(/(\d+)px/)?.[1])||20)*.52};},fillRect(...args){calls.push(['rect',this.fillStyle,...args]);},strokeRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},save(){},restore(){},drawImage(...args){calls.push(['image',...args]);},createLinearGradient(){return {addColorStop(){}};},fillText(t){calls.push(['text',t,this.fillStyle]);}};
 return {canvas:{getContext:()=>ctx},calls};
}
test('real story exports contain only question, first-person CTA and upload URL',()=>{
 const {canvas,calls}=recordingCanvas();
 const look=backgrounds.validated({locationID:'monterey',urgency:'developing'}),image={naturalWidth:1080,naturalHeight:1920};
 storyImages.render(canvas,{headline:'Were you on Laureles Grade?',question:'PRIVATE QUESTION',context:'PRIVATE SOURCE CONTEXT',basis:'reported'},{...look,images:[image,image]});
 assert.equal(canvas.width,1080);assert.equal(canvas.height,1920);
 assert.equal(calls.filter(x=>x[0]==='image').length,2);
 assert.deepEqual(calls.filter(x=>x[0]==='text').map(x=>x[1]).join(' '),'Were you on Laureles Grade? Send photos or video to me. chriscerney.org/upload');
});
test('demo exports remain labeled, while private notes never enter the image',()=>{
 const {canvas,calls}=recordingCanvas();
 const look=backgrounds.validated({locationID:'monterey',urgency:'developing'}),image={naturalWidth:1080,naturalHeight:1920};
 storyImages.render(canvas,{headline:'Were you there?',question:'Did you see it?',context:'Example only',basis:'demo'},{...look,images:[image,image]});
 assert(calls.some(x=>x[1]==='DESIGN EXAMPLE · NO REAL INCIDENT'));
 assert(!calls.some(x=>/Example only|CHRIS CERNEY REPORTS|AI-ILLUSTRATED|Community reporting/.test(x[1])));
});
test('every chosen urgency changes the exported accent even if artwork cannot load',()=>{
 const exported=new Set();
 for(const style of backgrounds.styles){const {canvas,calls}=recordingCanvas();storyImages.render(canvas,{headline:'Were you there?'},backgrounds.validated({locationID:'monterey',urgency:style.id}));
  assert(calls.some(x=>x[0]==='text'&&x[1]==='chriscerney.org/upload'&&x[2]===style.color));
  exported.add(JSON.stringify(calls));
 }assert.equal(exported.size,5);
});
test('explicit reviewed urgency takes precedence over keyword suggestions',()=>{
 assert.equal(backgrounds.suggested({headline:'Evacuation order',basis:'official',urgency:'update'}).urgency,'update');
});
test('an empty question cannot produce a shareable image',()=>{
 const {canvas}=recordingCanvas();
 assert.throws(()=>storyImages.render(canvas,{headline:'  '}),/Add a short question/);
});

test('tri-county locations and parent districts retain specificity',()=>{
 for(const [input,id] of [['Santa Cruz, Santa Cruz County','santa-cruz'],['Seabright, Santa Cruz','seabright'],['San Juan Bautista, San Benito County','san-juan-bautista'],['Pajaro Dunes','pajaro-dunes'],['Aptos Hills Larkin Valley','aptos-hills'],['Hollister near Highway 101','hollister'],['Highway 9 between Felton and Ben Lomond','san-lorenzo-valley']])assert.equal(backgrounds.match(input)?.id,id,input);
 assert.deepEqual(backgrounds.catalog.find(x=>x.id==='aromas').counties,['Monterey','San Benito']);
});
