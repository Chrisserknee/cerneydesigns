'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createEmailSender,FROM,REPLY_TO}=require('../../functions-booking/sponsorship-resend');
const {dispatchOutbox}=require('../../functions-booking/sponsorship-outbox');
const job={id:'booking-1-request-owner',to:'owner@example.test',subject:'Example business wants to partner',text:'Private request details'};
function sender(fetchImpl,overrides={}){return createEmailSender({secret:()=> 're_test_only',enabled:()=>true,fetchImpl,...overrides});}

test('Resend is disabled until explicitly enabled with a configured key',async()=>{
    let called=false;const fetchImpl=async()=>{called=true;};
    for(const overrides of [{enabled:()=>false},{secret:()=>''},{secret:()=> 'not-a-key'}]){
        const mail=sender(fetchImpl,overrides);assert.equal(mail.ready(),false);
        await assert.rejects(mail.send(job,job.id),/not enabled/);
    }
    assert.equal(called,false);
});

test('Resend sends the frozen text and routes replies to Chris with stable idempotency',async()=>{
    const calls=[];const mail=sender(async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:'email_123'})};});
    assert.equal(await mail.send(job,job.id),'email_123');await mail.send(job,job.id);
    assert.equal(calls[0].url,'https://api.resend.com/emails');
    assert.equal(calls[0].options.headers['Idempotency-Key'],job.id);
    assert.equal(calls[0].options.body,calls[1].options.body);
    assert.equal(calls[0].options.redirect,'error');
    assert.deepEqual(JSON.parse(calls[0].options.body),{from:FROM,to:[job.to],reply_to:REPLY_TO,subject:job.subject,text:job.text});
    assert.equal(mail.idempotencyWindowMs,23*60*60*1000);
});

test('Resend failures and malformed receipts cannot mark a notification sent or leak its contents',async()=>{
    for(const response of [{ok:false,json:async()=>({message:'Private request details'})},{ok:true,json:async()=>({})},{ok:true,json:async()=>({id:'private\ncontent'})}]){
        const mail=sender(async()=>response);
        await assert.rejects(mail.send(job,job.id),error=>!error.message.includes(job.text));
    }
    let sent=false;const mail=sender(async()=>{sent=true;});
    await assert.rejects(mail.send({...job,to:'one@example.test,two@example.test'},job.id),/Invalid/);
    await assert.rejects(mail.send({...job,subject:'Subject\r\nBcc: other@example.test'},job.id),/Invalid/);
    assert.equal(sent,false);
});

test('outbox retries an ambiguous Resend result using the same key and stops before key expiry',async()=>{
    let clock=1000,calls=0;const keys=[];
    const data={outbox:{[job.id]:{...job,state:'queued',attempts:0,createdAt:clock}}};
    const store={read:async()=>structuredClone(data),change:async fn=>fn(data)};
    const mail=sender(async(_url,options)=>{
        keys.push(options.headers['Idempotency-Key']);calls++;
        if(calls===1)throw new Error('Connection lost after acceptance');
        return {ok:true,json:async()=>({id:'email_123'})};
    });
    await dispatchOutbox(store,mail,()=>clock);assert.equal(data.outbox[job.id].state,'queued');
    clock+=300000;await dispatchOutbox(store,mail,()=>clock);
    assert.equal(data.outbox[job.id].state,'sent');assert.equal(data.outbox[job.id].receipt,'email_123');assert.deepEqual(keys,[job.id,job.id]);
    Object.assign(data.outbox[job.id],{state:'queued',leaseUntil:0});clock=1000+mail.idempotencyWindowMs+1;
    await dispatchOutbox(store,mail,()=>clock);assert.equal(data.outbox[job.id].state,'needs-review');assert.equal(calls,2);
});

test('outbox yields slow batches before the function deadline without claiming the next job',async()=>{
    let clock=1000,calls=0;const data={outbox:{}};
    for(let i=0;i<10;i++)data.outbox['job-'+i]={...job,id:'job-'+i,state:'queued',attempts:0};
    const store={read:async()=>structuredClone(data),change:async fn=>fn(data)};
    const mail=sender(async()=>{calls++;clock+=10000;return {ok:true,json:async()=>({id:'email_'+calls})};});
    await dispatchOutbox(store,mail,()=>clock);
    assert.equal(calls,6);assert.equal(data.outbox['job-6'].state,'queued');assert.equal(data.outbox['job-6'].attempts,0);
});
