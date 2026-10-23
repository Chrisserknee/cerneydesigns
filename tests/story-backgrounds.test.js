'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const backgrounds=require('../tip-alerts/story-backgrounds');
const storyImages=require('../tip-alerts/story-requests');
test('all twelve cities and every catalog image are packaged',()=>{
 assert.equal(backgrounds.catalog.filter(x=>x.kind==='city').length,12);
 assert.equal(new Set(backgrounds.catalog.map(x=>x.id)).size,backgrounds.catalog.length);
 const files=[...backgrounds.catalog.map(x=>x.id),...backgrounds.styles.map(x=>'style-'+x.id),'police-lights'];
 assert.equal(files.length,47);
 for(const file of files){const bytes=fs.readFileSync(path.join(__dirname,'../tip-alerts/backgrounds/v1',file+'.jpg'));assert.deepEqual([...bytes.subarray(0,2)],[255,216]);assert(bytes.length>10000,file);}
});
test('precise community and road matching retains local specificity',()=>{
 for(const [input,id]of [['Carmel Valley Village, Monterey County','carmel-valley'],['Carmel Highlands','carmel-highlands'],['Cannery Row, Monterey','monterey-waterfront'],['Highway 68 between Salinas and Monterey','toro'],['Pebble Beach','del-monte-forest']])assert.equal(backgrounds.match(input)?.id,id,input);
});
test('broad, ambiguous and out-of-area names do not fabricate city matches',()=>{
 for(const text of ['Monterey County','Monterey Bay','Salinas River','Monterey Park','Marina del Rey','Santa Cruz','Salinas and Monterey','Greenfield Road'])assert.equal(backgrounds.match(text),null,text);
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
 assert.deepEqual(urls,['/tip-alerts/backgrounds/v1/central-coast.jpg','/tip-alerts/backgrounds/v1/style-community.jpg']);
 assert.equal(backgrounds.paths({locationID:'monterey',urgency:'urgent',policeLights:true}).at(-1),'/tip-alerts/backgrounds/v1/police-lights.jpg');
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
test('canvas exports include location artwork and an illustration disclosure',()=>{
 const calls=[],ctx={font:'',fillStyle:'',measureText:t=>({width:t.length*17}),fillRect(){},strokeRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},save(){},restore(){},drawImage(...args){calls.push(['image',...args]);},createLinearGradient(){return {addColorStop(){}};},fillText(t){calls.push(['text',t]);}};
 const canvas={getContext:()=>ctx},look=backgrounds.validated({locationID:'monterey',urgency:'developing'}),image={naturalWidth:1080,naturalHeight:1920};
 storyImages.render(canvas,{headline:'Were you there?',question:'Did you see it?',context:'Example only',basis:'demo'},{...look,images:[image,image]});
 assert.equal(canvas.width,1080);assert.equal(canvas.height,1920);
 assert.equal(calls.filter(x=>x[0]==='image').length,2);
 assert(calls.some(x=>x[1]==='MONTEREY / DOWNTOWN'));
 assert(calls.some(x=>String(x[1]).includes('AI-ILLUSTRATED BACKGROUND')));
});
