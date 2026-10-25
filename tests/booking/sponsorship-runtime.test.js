'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{createHmac}=require('node:crypto');
const {freshState}=require('../../functions-booking/sponsorship-workflow');
function runtime(){
    const secret='s'.repeat(40),webhook='whsec_fixture';let data=freshState(),generation=1,vanish=false,saves=0;const received=[];
    data.config.revision=7;
    const bucket={file(_path,options){return {
        getMetadata:async()=>[{generation}],download:async()=>{if(vanish){vanish=false;generation++;throw {code:404};}if(options?.generation!==generation)throw {code:404};return [Buffer.from(JSON.stringify(data))];},
        save:async(body,opts)=>{if(opts.preconditionOpts.ifGenerationMatch!==generation)throw {code:412};data=JSON.parse(body);generation++;saves++;}
    };}};
    const actual=require('../../functions-booking/sponsorship-workflow');
    const trustedInvoice={id:'in_trusted',status:'paid',metadata:{sponsorshipId:'test'}};
    const context={exports:{},Buffer,Date,URL,require(name){
        if(name==='firebase-functions/v2/https')return {onRequest:(_o,f)=>f};
        if(name==='firebase-functions/v2/scheduler')return {onSchedule:(_o,f)=>f};
        if(name==='firebase-functions/params')return {defineSecret:n=>({value:()=>n.includes('WEBHOOK')?webhook:secret}),defineString:(_n,options)=>({value:()=>options.default}),defineBoolean:(_n,options)=>({value:()=>options.default})};
        if(name==='firebase-admin/storage')return {getStorage:()=>({bucket:()=>bucket})};
        if(name==='google-auth-library')return {GoogleAuth:class{constructor(){throw new Error('Settings must not initialize Google auth');}}};
        if(name==='./sponsorship-workflow')return {...actual,createWorkflow:options=>({...actual.createWorkflow(options),paymentReceived:async invoice=>received.push(invoice)})};
        if(name==='./sponsorship-providers')return {createCalendar:()=>({}),createPayments:()=>({retrieve:async()=>trustedInvoice})};
        if(name.startsWith('./'))return require('../../functions-booking/'+name.slice(2));return require(name);
    }};
    vm.runInNewContext(fs.readFileSync(__dirname+'/../../functions-booking/sponsorships.js','utf8'),context);
    async function invoke(handler,body,headers){const res={set(){},status(code){this.code=code;return this;},json(value){this.data=value;return this;},sendStatus(code){this.code=code;return this;}};await handler({method:'POST',body,rawBody:Buffer.from(JSON.stringify(body)),headers},res);return res;}
    return {received,vanish:()=>vanish=true,saves:()=>saves,
        api:async(body,valid=true)=>{const t=String(Date.now());return invoke(context.exports.cerneyBookingApi,body,{'x-tip-timestamp':t,'x-tip-signature':createHmac('sha256',valid?secret:'bad').update(t+'.'+JSON.stringify(body)).digest('hex')});},
        webhook:async(body,valid=true,age=0)=>{const t=String(Math.floor(Date.now()/1000)-age);return invoke(context.exports.cerneyBookingStripeWebhook,body,{'stripe-signature':`t=${t},v1=${createHmac('sha256',valid?webhook:'bad').update(t+'.'+JSON.stringify(body)).digest('hex')}`});}};
}
test('runtime reads draft settings without credentials and retries a vanished storage generation',async()=>{
    const h=runtime();h.vanish();const r=await h.api({op:'settings'});assert.equal(r.data.config.revision,7);assert.equal(r.data.integrationsReady,false);assert.equal(h.saves(),0);
    assert.equal((await h.api({op:'settings'},false)).code,403);
});
test('webhook rejects invalid and expired signatures, then retrieves the invoice from Stripe',async()=>{
    const h=runtime(),event={type:'invoice.paid',data:{object:{id:'in_trusted',amount_paid:1,metadata:{sponsorshipId:'test'}}}};
    assert.equal((await h.webhook(event,false)).code,400);assert.equal((await h.webhook(event,true,301)).code,400);assert.equal(h.received.length,0);
    assert.equal((await h.webhook(event)).data.received,true);assert.equal(h.received.length,1);assert.equal(h.received[0].id,'in_trusted');assert.equal(h.received[0].amount_paid,undefined);
});
