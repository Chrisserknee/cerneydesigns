(function(root){
 'use strict';
 const ID=/^[a-f0-9]{64}$/;
 const validID=value=>typeof value==='string'&&ID.test(value);
 const bounded=(value,max)=>typeof value==='string'&&value.length<=max;
 const types=['tip','note','research'];

 // Persist metadata only. Large originals stay in the file picker / verified cloud chunks.
 function fileIdentity(file){return [file.name,file.size,file.lastModified].join(':');}
 function fileRecord(file){
  if(!file||!bounded(file.name,1024)||!Number.isSafeInteger(file.size)||file.size<0||!Number.isFinite(file.lastModified))return null;
  return {name:file.name,size:file.size,lastModified:file.lastModified,type:bounded(file.type,100)?file.type:''};
 }
 function draftRecord(value){
  if(!value||value.version!==1||!validID(value.id)||!bounded(value.text,4000)||!bounded(value.title,180)||!Number.isFinite(Date.parse(value.updatedAt)))throw Error('The draft could not be saved. Keep this page open.');
  if(!Array.isArray(value.assetIDs)||value.assetIDs.length>20||!value.assetIDs.every(validID)||!Array.isArray(value.sourceRefs)||value.sourceRefs.length>12||!Array.isArray(value.uploads)||value.uploads.length>20)throw Error('Too many draft attachments.');
  const refs=value.sourceRefs.map(r=>{if(!r||!types.includes(r.kind)||!validID(r.id))throw Error('Invalid draft source.');return {kind:r.kind,id:r.id,...(bounded(r.label,240)?{label:r.label}:{})};});
  const uploads=value.uploads.map(fileRecord);if(uploads.some(x=>!x))throw Error('Invalid draft file.');
  const p=value.preferences||{},preferences={};
  for(const key of ['format','banner','length']){if(!bounded(p[key],40))throw Error('Invalid draft style.');preferences[key]=p[key];}
  for(const key of ['captions','originalAudio','noMusic']){if(typeof p[key]!=='boolean')throw Error('Invalid draft option.');preferences[key]=p[key];}
  return {version:1,id:value.id,text:value.text,title:value.title,titleEdited:value.titleEdited===true,preferences,sourceRefs:refs,assetIDs:[...new Set(value.assetIDs)],uploads,updatedAt:value.updatedAt};
 }
 function hasWork(draft){return !!(draft.text.trim()||draft.titleEdited&&draft.title.trim()||draft.uploads.length||draft.sourceRefs.length||draft.assetIDs.length);}
 async function open(scope,indexedDB=root.indexedDB){
  if(!validID(scope)||!indexedDB)throw Error('Private draft storage is unavailable.');
  const db=await new Promise((resolve,reject)=>{
   let rejected=false;
   const fail=message=>{rejected=true;reject(Error(message));};
   const request=indexedDB.open('cerney-producer-outbox-v1',2);
   request.onupgradeneeded=()=>{
    const db=request.result;
    if(!db.objectStoreNames.contains('outbox'))db.createObjectStore('outbox');
    if(!db.objectStoreNames.contains('drafts'))db.createObjectStore('drafts',{keyPath:['scope','id']}).createIndex('scope','scope');
    if(!db.objectStoreNames.contains('workspace'))db.createObjectStore('workspace');
   };
   request.onerror=()=>fail('Private draft storage is unavailable.');
   request.onblocked=()=>fail('Close other Producer Desk tabs, then reopen this one to enable draft saving.');
   request.onsuccess=()=>{if(rejected)request.result.close();else resolve(request.result);};
  });
  db.onversionchange=()=>db.close();
  function transaction(stores,mode,work){
   return new Promise((resolve,reject)=>{
    let result,failure;
    try{
     const tx=db.transaction(stores,mode);
     tx.oncomplete=()=>resolve(result?.result);
     tx.onabort=tx.onerror=()=>reject(failure||Error('Couldn’t save on this device. Keep this page open.'));
     result=work(tx,error=>{failure=error;tx.abort();});
    }catch{reject(Error('Private draft storage is unavailable.'));}
   });
  }
  return {
   pending:()=>transaction(['outbox'],'readonly',tx=>tx.objectStore('outbox').get(scope)),
   queue:request=>transaction(['outbox'],'readwrite',(tx,abort)=>{
    const store=tx.objectStore('outbox'),old=store.get(scope);
    old.onsuccess=()=>{
     if(old.result&&old.result.requestID!==request.requestID)return abort(Error('Another request is already saved on this device. Reopen Producer Desk to retry it first.'));
     store.put(request,scope);
    };
   }),
   list:async()=>{
    const rows=await transaction(['drafts'],'readonly',tx=>tx.objectStore('drafts').index('scope').getAll(scope));
    return rows.map(row=>{try{return draftRecord(row);}catch{return null;}}).filter(Boolean).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
   },
   active:()=>transaction(['workspace'],'readonly',tx=>tx.objectStore('workspace').get(scope)),
   save:value=>{
    const draft=draftRecord(value);
    return transaction(['drafts','workspace'],'readwrite',tx=>{
     const store=tx.objectStore('drafts');
     if(hasWork(draft))store.put({...draft,scope});else store.delete([scope,draft.id]);
     tx.objectStore('workspace').put(draft.id,scope);
    });
   },
   // Clear both records in one transaction only after the cloud accepts this exact request.
   complete:request=>transaction(['outbox','drafts'],'readwrite',tx=>{
    const outbox=tx.objectStore('outbox'),read=outbox.get(scope);
    read.onsuccess=()=>{if(read.result?.requestID===request.requestID){outbox.delete(scope);tx.objectStore('drafts').delete([scope,request.id]);}};
   }),
   close:()=>db.close()
  };
 }
 const api={open,draftRecord,fileRecord,fileIdentity,hasWork};
 root.CerneyProducerDrafts=api;
 if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis==='undefined'?window:globalThis);
