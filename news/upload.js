// Resumable direct upload. A lost chunk response is reconciled with the
// storage session before resending, including a lost final acknowledgement.
export async function uploadFile(file,session,progress=()=>{}) {
  const size=file.size,chunkSize=8*1024*1024;
  if(!session?.uri?.startsWith('https://storage.googleapis.com/upload/'))throw new Error('Invalid upload destination.');
  const request=(blob,range,onProgress)=>new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('PUT',session.uri);xhr.timeout=120000;
    xhr.setRequestHeader('Content-Range',range);xhr.setRequestHeader('Content-Type',file.type);
    xhr.upload.onprogress=event=>{if(event.lengthComputable&&onProgress)onProgress(event.loaded);};
    xhr.onload=()=>resolve({status:xhr.status,range:xhr.getResponseHeader('Range')});
    xhr.onerror=xhr.ontimeout=()=>reject(new Error('Upload connection interrupted.'));
    xhr.send(blob);
  });
  let offset=0,failures=0;
  while(offset<size){
    const end=Math.min(size,offset+chunkSize);let response;
    try{response=await request(file.slice(offset,end),`bytes ${offset}-${end-1}/${size}`,loaded=>progress(Math.min(.99,(offset+loaded)/size)));}
    catch{response={status:0};}
    if(response.status===200||response.status===201){progress(1);return session.id;}
    if(response.status===308){const match=/^bytes=0-(\d+)$/.exec(response.range||'');const next=match?Number(match[1])+1:0;if(next>offset&&next<=size){offset=next;failures=0;continue;}}
    if([400,401,403,404,410,413].includes(response.status))throw new Error('This upload session cannot continue. Select the file again to start a new upload.');
    if(++failures>5)throw new Error('The connection is interrupted. Keep this page open and retry the upload.');
    await new Promise(resolve=>setTimeout(resolve,Math.min(15000,1000*2**failures)));
    try{const status=await request(null,`bytes */${size}`);if([200,201].includes(status.status)){progress(1);return session.id;}if(status.status===308){const match=/^bytes=0-(\d+)$/.exec(status.range||'');offset=match?Number(match[1])+1:0;}}
    catch{}
  }
  progress(1);return session.id;
}
