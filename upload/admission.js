import { initializeAuth, inMemoryPersistence, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
const auths=new WeakMap(), grants=new Map();
export async function authorizeUpload(app,folder,files){
 const session=folder.replace(/^tips\//,'');
 let grant=grants.get(session);
 if(grant?.expiresAt>Date.now()+60000)return;
 if(grant?.pending)return grant.pending;
 if(!auths.has(app))auths.set(app,initializeAuth(app,{persistence:inMemoryPersistence}));
 const pending=(async()=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  try{
   const response=await fetch('/api/tip-upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session,files}),signal:controller.signal});
   const result=await response.json();
   if(!response.ok||!result.token)throw new Error(result.error||'Could not start upload. Please try again.');
   await signInWithCustomToken(auths.get(app),result.token);
   grants.set(session,{expiresAt:result.expiresAt});
  }finally{clearTimeout(timer);if(grants.get(session)?.pending)grants.delete(session);}
 })();
 grants.set(session,{pending});return pending;
}
