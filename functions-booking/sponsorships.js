'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
const {onRequest}=require('firebase-functions/v2/https');
const {onSchedule}=require('firebase-functions/v2/scheduler');
const {defineSecret,defineBoolean,defineString}=require('firebase-functions/params');
const {getStorage}=require('firebase-admin/storage');
const {GoogleAuth}=require('google-auth-library');
const {gatewayAuthenticated}=require('./request-auth');
const {createWorkflow,freshState}=require('./sponsorship-workflow');
const {createCalendar,createPayments}=require('./sponsorship-providers');
const {dispatchOutbox}=require('./sponsorship-outbox');
const {createEmailSender}=require('./sponsorship-resend');
const {fail}=require('./sponsorship-core');
const proxy=defineSecret('BOOKING_PROXY_SECRET');
const stripeKey=defineSecret('BOOKING_STRIPE_SECRET_KEY');
const webhookKey=defineSecret('BOOKING_STRIPE_WEBHOOK_SECRET');
const googleCredentials=defineSecret('SPONSORSHIP_GOOGLE_CREDENTIALS');
const resendKey=defineSecret('SPONSORSHIP_RESEND_API_KEY');
const emailEnabled=defineBoolean('BOOKING_EMAIL_ENABLED',{default:false});
const recurringEnabled=defineBoolean('BOOKING_RECURRING_ENABLED',{default:false});
const mode=defineString('BOOKING_MODE',{default:'sandbox'});
const storagePath=()=>{const value=mode.value();if(!['sandbox','live'].includes(value))throw new Error('Invalid booking mode');return '_cerney-booking/v1/'+value+'/state.json';};
const options={region:'us-west1',memory:'256MiB',timeoutSeconds:120,maxInstances:3};
const object=()=>getStorage().bucket('tip-line-8c2d7.firebasestorage.app').file(storagePath());
async function readVersion(){
    for(let i=0;i<8;i++){
        let meta;try{[meta]=await object().getMetadata();}catch(e){if(e.code===404)return {data:freshState(),generation:0};throw e;}
        try{const [bytes]=await getStorage().bucket('tip-line-8c2d7.firebasestorage.app').file(storagePath(),{generation:meta.generation}).download();
            return {data:JSON.parse(bytes),generation:meta.generation};}catch(e){if(e.code!==404)throw e;}
    }
    fail('Booking information changed. Try again.',409);
}
const store={async read(){return (await readVersion()).data;},async change(fn){
    for(let i=0;i<8;i++){
        const current=await readVersion(),result=fn(current.data),data=JSON.stringify(current.data);
        if(Buffer.byteLength(data)>8*1024*1024)fail('Booking storage needs maintenance. Please contact Chris.',503);
        try{await object().save(data,{resumable:false,contentType:'application/json',metadata:{cacheControl:'no-store'},preconditionOpts:{ifGenerationMatch:current.generation}});return result;}
        catch(e){if(e.code!==412)throw e;}
    }
    fail('Booking information changed. Try again.',409);
}};
// Enable only after domain verification, secret binding, and delivery testing.
const notifications=createEmailSender({secret:()=>resendKey.value(),enabled:()=>emailEnabled.value()});
function workflow(){
    // Reading settings and drafting the package does not require calendar credentials.
    let googleClient;
    const auth={getClient:()=>googleClient||(googleClient=new GoogleAuth({credentials:JSON.parse(googleCredentials.value()),scopes:['https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/calendar.freebusy']}).getClient())};
    const calendar=createCalendar({auth});const payments=createPayments({secret:()=>stripeKey.value()});
    return createWorkflow({store,calendar,payments,ready:()=>{try{return new RegExp('^(sk|rk)_'+(mode.value()==='live'?'live':'test')+'_').test(stripeKey.value())&&!!JSON.parse(googleCredentials.value()).client_email;}catch{return false;}},recurringReady:()=>recurringEnabled.value()});
}
exports.cerneyBookingApi=onRequest({...options,secrets:[proxy,stripeKey,googleCredentials,resendKey]},async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(req.method!=='POST'||!gatewayAuthenticated(req,proxy.value()))return res.status(403).json({error:'Forbidden.'});
    if(req.rawBody.length>50000)return res.status(413).json({error:'Request too large.'});
    try{const result=await workflow().handle(req.body||{});if(req.body?.op==='settings'){result.notificationsEnabled=emailEnabled.value();result.mode=mode.value();}return res.json(result);}
    catch(e){const code=[400,404,409,429,503].includes(e.code)?e.code:503;return res.status(code).json({error:code===503?'Sponsorship setup or a connected service needs attention. Please contact Chris.':e.message});}
});
exports.cerneyBookingStripeWebhook=onRequest({...options,secrets:[stripeKey,webhookKey,googleCredentials]},async(req,res)=>{
    res.set('Cache-Control','no-store');if(req.method!=='POST')return res.sendStatus(405);
    try{
        const parts=String(req.headers['stripe-signature']||'').split(',').map(s=>s.split('=')),time=parts.find(p=>p[0]==='t')?.[1];
        if(!/^\d+$/.test(time||'')||Math.abs(Date.now()/1000-Number(time))>300||!Buffer.isBuffer(req.rawBody))return res.sendStatus(400);
        const expected=createHmac('sha256',webhookKey.value()).update(time+'.').update(req.rawBody).digest();
        if(!parts.some(([k,v])=>k==='v1'&&/^[a-f0-9]{64}$/.test(v||'')&&timingSafeEqual(expected,Buffer.from(v,'hex'))))return res.sendStatus(400);
        const event=JSON.parse(req.rawBody),object=event.data?.object;
        if(!object)return res.json({received:true});
        const payments=createPayments({secret:()=>stripeKey.value()});
        if(event.type==='invoice.paid'){
            const identity=require('./sponsorship-recurring').invoiceIdentity(object);
            if(identity.metadata?.sponsorshipId)await workflow().paymentReceived(await payments.retrieve(object.id));
        }else if(['customer.subscription.updated','customer.subscription.deleted'].includes(event.type)&&object.metadata?.sponsorshipId){
            await workflow().subscriptionChanged(await payments.retrieveSubscription(object.id));
        }else if(event.type==='invoice.payment_failed'){
            const identity=require('./sponsorship-recurring').invoiceIdentity(object);
            if(identity.metadata?.sponsorshipId&&identity.subscriptionId)await workflow().subscriptionChanged(await payments.retrieveSubscription(identity.subscriptionId));
        }
        return res.json({received:true});
    }catch{return res.sendStatus(500);}
});
exports.retryCerneyBookingWork=onSchedule({...options,schedule:'every 5 minutes',secrets:[stripeKey,googleCredentials,resendKey]},async()=>{
    await workflow().reconcile();if(emailEnabled.value())await dispatchOutbox(store,notifications);
});
