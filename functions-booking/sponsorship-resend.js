'use strict';

const FROM='Chris Cerney <sponsorships@bookings.chriscerney.org>';
const REPLY_TO='cerneymedia@gmail.com';
const address=/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

function createEmailSender({secret,enabled=()=>false,fetchImpl=globalThis.fetch}){
    const ready=()=>enabled()===true&&/^re_[A-Za-z0-9_-]+$/.test(secret()||'');
    return {
        ready,
        // Resend retains keys for 24 hours. Leave a margin for request latency.
        idempotencyWindowMs:23*60*60*1000,
        async send(job,key){
            if(!ready())throw new Error('Booking email is not enabled.');
            if(!address.test(job?.to||'')||typeof job.subject!=='string'||!job.subject.trim()||
                /[\r\n]/.test(job.subject)||typeof job.text!=='string'||!job.text||
                typeof key!=='string'||!key||key.length>256||/[\r\n]/.test(key)){
                throw new Error('Invalid booking email.');
            }
            const response=await fetchImpl('https://api.resend.com/emails',{
                method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
                headers:{Authorization:'Bearer '+secret(),'Content-Type':'application/json','Idempotency-Key':key},
                body:JSON.stringify({from:FROM,to:[job.to],reply_to:REPLY_TO,subject:job.subject,text:job.text})
            });
            // Never persist provider error bodies: they can echo private email content.
            if(!response.ok)throw new Error('Booking email was not accepted by Resend.');
            let receipt;try{receipt=await response.json();}catch{throw new Error('Missing booking email receipt.');}
            if(typeof receipt?.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(receipt.id))throw new Error('Missing booking email receipt.');
            return receipt.id;
        }
    };
}

module.exports={createEmailSender,FROM,REPLY_TO};
