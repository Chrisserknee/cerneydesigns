'use strict';
// This is only a bootstrap cache. Every catalog still lists current storage
// generations and ignores/replaces any cached record that no longer matches.
const NAME=/^_tipalerts\/v1\/(tips|incidents|enrichment|details|story-requests|deliveries|research)\/[a-f0-9]{64}\.json$/;
function validEntry(entry){return Array.isArray(entry)&&entry.length===2&&NAME.test(entry[0])&&entry[1]
    && /^\d{1,30}$/.test(String(entry[1].generation||''))&&entry[1].data&&typeof entry[1].data==='object';}
function createWarmCache({cache,read,write,now=Date.now}){
    let hydration,savedRevision=0,saving,retryAt=0;
    async function hydrate(){
        if(!hydration)hydration=(async()=>{
            try{const snapshot=await read();
                if(snapshot?.version===1 && Array.isArray(snapshot.entries) && snapshot.entries.length<=5000){
                    for(const entry of snapshot.entries){if(validEntry(entry))cache.set(entry[0],entry[1],Buffer.byteLength(JSON.stringify(entry[1].data)));}
                }
            }catch{/* Cache outages never prevent fresh source reads. */}
            savedRevision=cache.revision;
        })();
        return hydration;
    }
    async function save(){
        if(saving)return saving;
        if(cache.revision===savedRevision||now()<retryAt)return;
        const revision=cache.revision;
        const snapshot={version:1,createdAt:new Date(now()).toISOString(),entries:cache.entries().filter(validEntry)};
        saving=(async()=>{
            try{await write(snapshot);savedRevision=revision;}
            catch{retryAt=now()+60000;}
        })().finally(()=>{saving=null;});
        return saving;
    }
    return {hydrate,save};
}
module.exports={createWarmCache,validEntry};
