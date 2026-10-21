'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, profileMetadata, MARKER } = require('../api/_lib/spotlight');
const { createModeration } = require('../functions-spotlight/moderation');
const { createProviders } = require('../functions-spotlight/providers');

// These tests compose the production website, moderation and provider modules.
// Only Stripe, Resend and storage I/O are replaced with deterministic services.
function application() {
 const now=Math.floor(Date.now()/1000),end=now+30*86400;
 const profile={businessName:'Integration Test Coffee',category:'Food & drink',city:'Monterey',description:'Synthetic integration test only.',website:'https://example.com/',phone:'',logoUrl:''};
 const price={id:'price_integration',active:true,currency:'usd',unit_amount:10000,type:'recurring',billing_scheme:'per_unit',recurring:{interval:'month',interval_count:1,usage_type:'licensed'}};
 const invoice={id:'in_integration',livemode:false,billing_reason:'subscription_create',status:'paid',currency:'usd',amount_paid:10000,amount_due:10000,total:10000,amount_remaining:0,customer:'cus_integration',created:now,status_transitions:{paid_at:now},parent:{subscription_details:{subscription:'sub_integration'}},lines:{has_more:false,data:[{amount:10000,currency:'usd',quantity:1,period:{start:now,end},pricing:{price_details:{price:price.id}},parent:{subscription_item_details:{subscription:'sub_integration',subscription_item:'si_integration',proration:false}}}]}};
 const subscription={id:'sub_integration',customer:'cus_integration',livemode:false,status:'active',cancel_at_period_end:true,metadata:{spotlight:MARKER,spotlight_review_status:'pending',...profileMetadata(profile)},items:{has_more:false,data:[{id:'si_integration',quantity:1,current_period_start:now,current_period_end:end,price}]},latest_invoice:invoice,pause_collection:null};
 const history=[],emails=[],effects=[],data=new Map();
 const copy=structuredClone;
 const stripe={
  subscriptions:{retrieve:async()=>copy(subscription),list:async()=>({has_more:false,data:[copy(subscription)]}),update:async(id,p)=>{assert.equal(id,subscription.id);Object.assign(subscription.metadata,p.metadata);if('pause_collection'in p)subscription.pause_collection=p.pause_collection||null;effects.push({op:'update',value:copy(p)});return copy(subscription);},cancel:async(id,p)=>{assert.equal(id,subscription.id);assert.deepEqual(p,{invoice_now:false,prorate:false});subscription.status='canceled';effects.push({op:'cancel'});return copy(subscription);}},
  invoices:{retrieve:async()=>copy(invoice),list:async()=>({has_more:false,data:[copy(invoice)]})},
  invoicePayments:{list:async()=>({has_more:false,data:[{invoice:invoice.id,livemode:false,status:'paid',amount_paid:10000,currency:'usd',payment:{type:'payment_intent',payment_intent:{id:'pi_integration',livemode:false,status:'succeeded',amount:10000,amount_received:10000,currency:'usd',customer:subscription.customer,latest_charge:'ch_integration'}}}]})},
  charges:{retrieve:async()=>({id:'ch_integration',payment_intent:'pi_integration',customer:subscription.customer,livemode:false,status:'succeeded',paid:true,captured:true,amount:10000,amount_captured:10000,currency:'usd',amount_refunded:history.filter(r=>r.status==='succeeded').reduce((n,r)=>n+r.amount,0),refunded:history.some(r=>r.status==='succeeded'),disputed:false})},
  customers:{retrieve:async()=>({id:subscription.customer,livemode:false,email:'delivered@resend.dev'})},
  refunds:{list:async()=>({has_more:false,data:copy(history)}),create:async(p,o)=>{assert.equal(subscription.status,'canceled');assert.equal(p.payment_intent,'pi_integration');assert.equal(p.amount,10000);assert.ok(o.idempotencyKey);effects.push({op:'refund'});const refund={id:'re_integration',payment_intent:p.payment_intent,currency:'usd',amount:p.amount,status:'succeeded',created:now,metadata:p.metadata};history.push(refund);return copy(refund);},retrieve:async()=>copy(history[0])}
 };
 const store={read:async id=>copy(data.get(id)||null),create:async(id,r)=>{if(data.has(id))return false;data.set(id,copy(r));return true;},compareAndSwap:async(id,v,r)=>{if(data.get(id)?.revision!==v)return false;data.set(id,copy(r));return true;},listDue:async()=>[]};
 const settings={stripeKey:'rk_test_integration',secret:'rk_test_integration',priceId:price.id,live:false,moderationReady:true,reviewSecret:'integration-review-secret-with-more-than-32-characters',siteUrl:'https://preview.example.com',emailEnabled:true,resendKey:'re_integration'};
 const providers=createProviders({stripe,settings,fetchImpl:async(url,o)=>{emails.push({body:JSON.parse(o.body),key:o.headers['Idempotency-Key']});return{ok:true,json:async()=>({id:`receipt_${emails.length}`})};}});
 const core=createModeration({store,providers,settings});
 const service=createService(stripe,settings,(op,payload)=>core[op](payload));
 const event={id:'evt_integration',livemode:false,type:'invoice.paid',data:{object:{id:invoice.id,parent:invoice.parent}}};
 const token=()=>new URLSearchParams(new URL(emails.find(e=>e.key.endsWith(':owner-review')).body.text.match(/https:\/\/preview\.example\.com\/spotlightreview\/#[^\s]+/)[0]).hash.slice(1)).get('token');
 return{service,core,event,token,subscription,emails,effects,history,data};
}

test('verified purchase stays hidden; confirmed owner approval publishes exactly the reviewed profile',async()=>{
 const f=application();assert.equal((await f.service.directory()).listings.length,0);
 await f.service.webhook(f.event);
 assert.equal((await f.service.directory()).listings.length,0);
 assert.equal(f.subscription.metadata.spotlight_paid_invoice,'in_integration');
 assert.deepEqual(f.subscription.pause_collection,{behavior:'void'});
 assert.equal(f.emails.length,2);assert.equal(f.emails[0].body.to[0],'cerneymedia@gmail.com');
 const token=f.token();assert.equal((await f.core.review({token})).status,'pending');
 assert.equal((await f.service.directory()).listings.length,0);
 const result=await f.core.decide({token,decision:'approve',confirmed:true});
 assert.equal(result.status,'approved');assert.equal(f.subscription.pause_collection,null);assert.equal(f.subscription.cancel_at_period_end,true);
 const publicData=await f.service.directory();assert.equal(publicData.listings.length,1);assert.equal(publicData.listings[0].businessName,'Integration Test Coffee');
 assert.doesNotMatch(JSON.stringify(publicData),/delivered@|cerneymedia@|pi_integration|sub_integration/);
 await f.core.decide({token,decision:'approve',confirmed:true});await f.service.webhook(f.event);
 assert.equal(f.emails.length,3);assert.equal(f.history.length,0);
 await assert.rejects(f.core.decide({token,decision:'decline',reason:'Changed my mind.',confirmed:true}),{code:'DECISION_CONFLICT'});
});

test('decline hides permanently, cancels first, refunds pinned $100 once, then emails the supplied reason',async()=>{
 const f=application();await f.service.webhook(f.event);const token=f.token();
 const result=await f.core.decide({token,decision:'decline',reason:'This business is outside Monterey County.',confirmed:true});
 assert.equal(result.status,'declined');assert.equal(result.refundStatus,'succeeded');assert.equal(f.subscription.status,'canceled');
 assert.equal(f.history.length,1);assert.ok(f.effects.findIndex(e=>e.op==='cancel')<f.effects.findIndex(e=>e.op==='refund'));
 assert.equal((await f.service.directory()).listings.length,0);
 const email=f.emails.find(e=>e.key.endsWith(':applicant-declined'));assert.equal(email.body.to[0],'delivered@resend.dev');assert.match(email.body.text,/outside Monterey County/);assert.match(email.body.text,/confirmed a full \$100 refund/);
 await f.core.decide({token,decision:'decline',reason:'This business is outside Monterey County.',confirmed:true});await f.service.webhook(f.event);
 await f.service.webhook({type:'refund.updated',livemode:false,data:{object:f.history[0]}});
 assert.equal(f.history.length,1);assert.equal(f.emails.length,3);assert.equal((await f.service.directory()).listings.length,0);
 await assert.rejects(f.core.decide({token,decision:'approve',confirmed:true}),{code:'DECISION_CONFLICT'});
});
