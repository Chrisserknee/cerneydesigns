'use strict';
(function(root){
 const FONT='"Cerney News", "Arial Narrow", Arial, sans-serif';
 const masks=new WeakMap();let resources;
 // Bounded, local assets load once. A failed request can retry on the next preview.
 function load(){
  if(resources)return resources;
  let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Film assets took too long to load.')),10000);});
  resources=Promise.race([timeout,Promise.all([
   new FontFace('Cerney News','url(/tip-alerts/fonts/BarlowSemiCondensed-Bold.ttf)',{weight:'700'}).load().then(font=>document.fonts.add(font)),
   new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(Error('Film texture could not load.'));image.src='/tip-alerts/film/grain-v1.png';}),
   new FontFace('Cerney Digital','url(/tip-alerts/fonts/DSEG14Classic-Regular.ttf)',{weight:'400'}).load().then(font=>document.fonts.add(font))
  ]).then(([,grain])=>({grain}))]).finally(()=>clearTimeout(timer)).catch(error=>{resources=null;throw error;});
  return resources;
 }
 function blur(input,w,h,r){
  const mid=new Float32Array(input.length),out=new Float32Array(input.length),d=2*r+1;
  for(let y=0;y<h;y++){let sum=0;for(let dx=-r;dx<=r;dx++)sum+=input[y*w+Math.max(0,Math.min(w-1,dx))];for(let x=0;x<w;x++){mid[y*w+x]=sum/d;sum+=input[y*w+Math.min(w-1,x+r+1)]-input[y*w+Math.max(0,x-r)];}}
  for(let x=0;x<w;x++){let sum=0;for(let dy=-r;dy<=r;dy++)sum+=mid[Math.max(0,Math.min(h-1,dy))*w+x];for(let y=0;y<h;y++){out[y*w+x]=sum/d;sum+=mid[Math.min(h-1,y+r+1)*w+x]-mid[Math.max(0,y-r)*w+x];}}
  return out;
 }
 function haloAlpha(rgba,w,h){
  const mask=new Float32Array(w*h);
  for(let i=0;i<mask.length;i++){const p=i*4,light=(rgba[p]*.2126+rgba[p+1]*.7152+rgba[p+2]*.0722)/255,t=Math.max(0,Math.min(1,(light-.56)/.34));mask[i]=t*t*(3-2*t);}
  let glow=mask;for(const radius of [2,5,9])glow=blur(glow,w,h,radius);
  // Glow extends outside bright areas. Uniform bright regions do not get orange fog.
  return Uint8ClampedArray.from(glow,(value,i)=>Math.max(0,value-mask[i])*.88*255);
 }
 function halation(image){
  if(masks.has(image))return masks.get(image);
  const w=270,h=480,canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const c=canvas.getContext('2d',{willReadFrequently:true});
  const scale=Math.max(w/image.naturalWidth,h/image.naturalHeight),iw=image.naturalWidth*scale,ih=image.naturalHeight*scale;c.drawImage(image,(w-iw)/2,(h-ih)/2,iw,ih);
  const data=c.getImageData(0,0,w,h),alpha=haloAlpha(data.data,w,h);
  for(let i=0;i<alpha.length;i++){const p=i*4;data.data[p]=255;data.data[p+1]=100;data.data[p+2]=48;data.data[p+3]=alpha[i];}
  c.putImageData(data,0,0);masks.set(image,canvas);return canvas;
 }
 function paint(c,art,film){
  if(!film)return;
  c.save();
  if(art?.images?.[0]){c.globalCompositeOperation='screen';c.globalAlpha=.78;c.drawImage(halation(art.images[0]),0,0,1080,1920);}
  // A soft edge falloff and fine raster lines recall a field monitor, below the copy.
  c.globalCompositeOperation='source-over';c.globalAlpha=1;
  const vignette=c.createRadialGradient(540,900,280,540,900,1120);
  vignette.addColorStop(0,'rgba(0,0,0,0)');vignette.addColorStop(1,'rgba(0,0,0,.30)');
  c.fillStyle=vignette;c.fillRect(0,0,1080,1920);
  c.fillStyle='rgba(0,0,0,.065)';for(let y=0;y<1920;y+=6)c.fillRect(0,y,1080,1);
  // Shared full-frame texture is composited before typography: copy stays clean.
  c.globalCompositeOperation='soft-light';c.globalAlpha=.50;c.drawImage(film.grain,0,0,1080,1920);c.restore();
 }
 root.CerneyStoryFilm={FONT,load,paint,haloAlpha};
 if(typeof module!=='undefined')module.exports=root.CerneyStoryFilm;
})(typeof window==='undefined'?globalThis:window);
