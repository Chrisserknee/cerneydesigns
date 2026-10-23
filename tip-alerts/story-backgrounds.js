'use strict';
(function(root){
 const catalog=[{"id":"monterey","label":"Monterey / Downtown","kind":"city","aliases":["monterey","downtown monterey","alvarado street","alvarado st"]},{"id":"salinas","label":"Salinas","kind":"city","aliases":["salinas","oldtown salinas","old town salinas"]},{"id":"carmel","label":"Carmel-by-the-Sea","kind":"city","aliases":["carmel by the sea","carmel-by-the-sea","carmel"]},{"id":"del-rey-oaks","label":"Del Rey Oaks","kind":"city","aliases":["del rey oaks"]},{"id":"gonzales","label":"Gonzales","kind":"city","aliases":["gonzales"]},{"id":"greenfield","label":"Greenfield","kind":"city","aliases":["greenfield"]},{"id":"king-city","label":"King City","kind":"city","aliases":["king city"]},{"id":"marina","label":"Marina","kind":"city","aliases":["marina"]},{"id":"pacific-grove","label":"Pacific Grove","kind":"city","aliases":["pacific grove","lovers point","lovers' point"]},{"id":"sand-city","label":"Sand City","kind":"city","aliases":["sand city"]},{"id":"seaside","label":"Seaside","kind":"city","aliases":["seaside"]},{"id":"soledad","label":"Soledad","kind":"city","aliases":["soledad"]},{"id":"aromas","label":"Aromas","kind":"community","aliases":["aromas"]},{"id":"boronda","label":"Boronda","kind":"community","aliases":["boronda"]},{"id":"bradley","label":"Bradley","kind":"community","aliases":["bradley"]},{"id":"carmel-valley","label":"Carmel Valley Village","kind":"community","aliases":["carmel valley village","carmel valley","robles del rio"]},{"id":"castroville","label":"Castroville","kind":"community","aliases":["castroville"]},{"id":"chualar","label":"Chualar","kind":"community","aliases":["chualar"]},{"id":"del-monte-forest","label":"Pebble Beach / Del Monte Forest","kind":"community","aliases":["del monte forest","pebble beach","17 mile drive","seventeen mile drive"]},{"id":"elkhorn","label":"Elkhorn","kind":"community","aliases":["elkhorn","elkhorn slough"]},{"id":"las-lomas","label":"Las Lomas","kind":"community","aliases":["las lomas"]},{"id":"lockwood","label":"Lockwood","kind":"community","aliases":["lockwood"]},{"id":"moss-landing","label":"Moss Landing","kind":"community","aliases":["moss landing"]},{"id":"pajaro","label":"Pajaro","kind":"community","aliases":["pajaro"]},{"id":"pine-canyon","label":"Pine Canyon","kind":"community","aliases":["pine canyon"]},{"id":"prunedale","label":"Prunedale","kind":"community","aliases":["prunedale"]},{"id":"san-ardo","label":"San Ardo","kind":"community","aliases":["san ardo"]},{"id":"san-lucas","label":"San Lucas","kind":"community","aliases":["san lucas"]},{"id":"spreckels","label":"Spreckels","kind":"community","aliases":["spreckels","spreckles","spreckels junction"]},{"id":"big-sur","label":"Big Sur","kind":"region","aliases":["big sur","bixby","pfeiffer","posts","post ranch"]},{"id":"carmel-highlands","label":"Carmel Highlands","kind":"region","aliases":["carmel highlands","yankee point","malpaso"]},{"id":"royal-oaks","label":"Royal Oaks","kind":"region","aliases":["royal oaks"]},{"id":"east-garrison","label":"East Garrison / Fort Ord","kind":"region","aliases":["east garrison","fort ord","csumb","cal state monterey bay"]},{"id":"toro","label":"Toro / Highway 68","kind":"region","aliases":["toro park","toro","highway 68","hwy 68","sr 68","route 68","san benancio","corral de tierra","laguna seca"]},{"id":"cachagua","label":"Cachagua / Upper Carmel Valley","kind":"region","aliases":["cachagua","jamesburg","tassajara","upper carmel valley"]},{"id":"jolon","label":"Jolon / South County","kind":"region","aliases":["jolon","fort hunter liggett","hunter liggett","san antonio valley"]},{"id":"lucia","label":"Lucia / Gorda Coast","kind":"region","aliases":["lucia","gorda","pacific valley"]},{"id":"salinas-valley","label":"Salinas Valley / Highway 101","kind":"region","aliases":["salinas valley","highway 101","hwy 101","us 101","camphora","fort romie","metz","spence"]},{"id":"north-county","label":"North County / Rural","kind":"region","aliases":["north county","bolsa knolls","santa rita","gabilan acres","blanco","cooper","nashua","coburn","denvir","elsa","harlem","martinez corner","mascorini place","sycamore flat","welby"]},{"id":"monterey-waterfront","label":"Monterey Waterfront","kind":"district","aliases":["cannery row","fisherman's wharf","fishermans wharf","monterey harbor"]},{"id":"central-coast","label":"Central Coast / Unspecified","kind":"fallback","aliases":[]}];
 const styles=[{id:'community',label:'Community',color:'#51c8bd'},{id:'developing',label:'Developing',color:'#f1bd67'},{id:'urgent',label:'Urgent',color:'#fa8955'},{id:'critical',label:'Critical',color:'#ff7682'},{id:'update',label:'Update',color:'#a5baff'}];
 const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
 function match(value){
  let text=' '+normalize(value)+' ';
  if(['monterey park','marina del rey','seaside oregon','greenfield massachusetts'].some(x=>text.includes(' '+x+' ')))return null;
  for(const broad of ['monterey county','county of monterey','monterey bay','salinas river','salinas road','marina harbor','greenfield road','carmel river'])text=text.replaceAll(' '+broad+' ',' ');
  const candidates=[];
  for(const place of catalog)for(const alias of place.aliases){const key=' '+normalize(alias)+' ',start=text.indexOf(key);if(start>=0)candidates.push({place,key,start,end:start+key.length});}
  const precise=candidates.filter(c=>!candidates.some(o=>o.key.length>c.key.length&&o.start<=c.start&&o.end>=c.end));
  const districts=precise.filter(x=>x.place.kind==='district');
  if(new Set(districts.map(x=>x.place.id)).size===1&&precise.every(x=>[districts[0].place.id,'monterey'].includes(x.place.id)))return districts[0].place;
  if(new Set(precise.map(x=>x.place.id)).size===1)return precise[0].place;
  const roads=precise.filter(x=>['toro','salinas-valley'].includes(x.place.id));
  return new Set(roads.map(x=>x.place.id)).size===1?roads[0].place:null;
 }
 function suggested(story){
  const place=match(story.location?.trim()?story.location:story.headline);
  const text=' '+normalize([story.headline,story.question,story.context].join(' '))+' ';
  const has=words=>words.some(x=>text.includes(' '+x+' ')),official=story.basis==='official';
  let urgency='community';
  if(has(['police','crash','collision','fire','road closure','incident','flood','evacuation']))urgency='developing';
  if(official&&has(['active fire','road closed','road closure','active incident','urgent']))urgency='urgent';
  if(official&&has(['evacuation order','shelter in place','immediate danger','immediate threat']))urgency='critical';
  if(official&&has(['all clear','reopened','resolved','final update']))urgency='update';
  if(styles.some(x=>x.id===story.urgency))urgency=story.urgency;
  return {locationID:place?.id||'central-coast',urgency,policeLights:story.category==='police'};
 }
 function validated(look){
  const place=catalog.find(x=>x.id===look?.locationID)||catalog.find(x=>x.id==='central-coast');
  const style=styles.find(x=>x.id===look?.urgency)||styles[0];
  return {place,style,policeLights:look?.policeLights===true};
 }
 function paths(look){const v=validated(look);return [v.place.id,'style-'+v.style.id,...(v.policeLights?['police-lights']:[])].map(name=>'/tip-alerts/backgrounds/v1/'+name+'.jpg');}
 const images=new Map();
 function image(url){
  if(images.has(url))return images.get(url);
  const promise=new Promise((resolve,reject)=>{const img=new Image();const timer=setTimeout(()=>{img.src='';reject(Error('Background took too long to load.'));},10000);img.onload=()=>{clearTimeout(timer);resolve(img);};img.onerror=()=>{clearTimeout(timer);reject(Error('Background could not load.'));};img.src=url;});
  images.set(url,promise);promise.catch(()=>images.delete(url));
  while(images.size>8)images.delete(images.keys().next().value);
  return promise;
 }
 async function load(look){const v=validated(look),loaded=await Promise.all(paths(look).map(image));return {...v,images:loaded};}
 function cover(ctx,img){const scale=Math.max(1080/img.naturalWidth,1920/img.naturalHeight),w=img.naturalWidth*scale,h=img.naturalHeight*scale;ctx.drawImage(img,(1080-w)/2,(1920-h)/2,w,h);}
 function paint(ctx,art){
  ctx.save();cover(ctx,art.images[0]);ctx.globalCompositeOperation='soft-light';ctx.globalAlpha=.72;cover(ctx,art.images[1]);
  if(art.images[2]){ctx.globalCompositeOperation='screen';ctx.globalAlpha=.40;cover(ctx,art.images[2]);}
  ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;
  const shade=ctx.createLinearGradient(0,0,0,1920);for(const [stop,alpha]of [[0,.60],[.28,.78],[.70,.74],[1,.48]])shade.addColorStop(stop,'rgba(15,43,61,'+alpha+')');ctx.fillStyle=shade;ctx.fillRect(0,0,1080,1920);ctx.restore();
 }
 root.CerneyStoryBackgrounds={catalog,styles,normalize,match,suggested,validated,paths,load,paint};
 if(typeof module!=='undefined')module.exports=root.CerneyStoryBackgrounds;
})(typeof window==='undefined'?globalThis:window);
