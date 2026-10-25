(()=>{'use strict';
 const origin='https://www.chriscerney.org',valid=/^[a-f0-9]{64}$/,attempted=new Set();
 function target(value){
  let u;try{u=new URL(value,origin);}catch{return null;}
  if(u.origin!==origin||u.pathname!=='/tip-alerts/'||u.username||u.password||u.searchParams.has('web'))return null;
  const items=['tip','story'].flatMap(kind=>u.searchParams.getAll(kind).map(id=>({kind,id})));
  if(items.length===1&&valid.test(items[0].id))return 'cerneytips://'+items[0].kind+'/'+items[0].id;
  if(!items.length&&u.searchParams.get('test')==='1')return 'cerneytips://open';
  return null;
 }
 let pending=null;
 function resume(){
  if(!pending||document.hidden)return;
  const href=pending;pending=null;
  if(globalThis.CerneyNewsroom?.hasUnsavedWork()||attempted.has(href))return;
  attempted.add(href);location.href=href;
 }
 document.addEventListener('visibilitychange',resume);
 function open(value){
  const href=target(value),ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  if(!href||!ios)return false;
  const box=document.getElementById('nativeHandoff'),link=document.getElementById('nativeAppLink');if(!box||!link)return false;
  link.href=href;box.hidden=false;
  // Never interrupt an unsaved recording or notebook. The explicit link remains available.
  const unsaved=globalThis.CerneyNewsroom?.hasUnsavedWork();
  if(!unsaved&&!attempted.has(href)&&(navigator.standalone||matchMedia('(display-mode: standalone)').matches)){
   pending=href;resume();
  }
  return true;
 }
 globalThis.CerneyNativeHandoff={target,open};
})();
