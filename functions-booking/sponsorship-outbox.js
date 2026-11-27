'use strict';
// A durable queue. A sender must provide provider-side idempotency using job.id.
// An uncertain send older than the provider's retention window requires review.
async function dispatchOutbox(store,sender,now=Date.now){
    if(!sender?.ready())return;
    const deadline=now()+60000;
    const pending=Object.values((await store.read()).outbox).filter(j=>['queued','sending'].includes(j.state)).slice(0,20);
    for(const job of pending){
        if(now()>=deadline)break;
        const claimed=await store.change(s=>{
            const j=s.outbox[job.id];if(!['queued','sending'].includes(j.state)||j.leaseUntil>now())return false;
            if (['approved-client','invoice-client'].includes(j.type)) {
                const order=s.orders?.[j.id.slice(0,-j.type.length-1)];
                if (order?.paymentDueAt && now()>=order.paymentDueAt) {j.state='superseded';return false;}
            }
            if(j.firstAttemptAt&&now()-j.firstAttemptAt>sender.idempotencyWindowMs){j.state='needs-review';j.lastError='Delivery needs review before retrying.';return false;}
            j.state='sending';j.firstAttemptAt=j.firstAttemptAt||now();j.leaseUntil=now()+120000;j.attempts++;return true;
        });
        if(!claimed)continue;
        try{const receipt=await sender.send(job,job.id);await store.change(s=>{Object.assign(s.outbox[job.id],{state:'sent',sentAt:now(),receipt,leaseUntil:0,lastError:null});});}
        catch{await store.change(s=>{Object.assign(s.outbox[job.id],{state:'queued',leaseUntil:0,lastError:'Delivery failed; waiting to retry.'});});}
    }
}
module.exports={dispatchOutbox};
