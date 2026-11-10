'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {reconcileCustomBilling}=require('../api/_lib/spotlight-custom-billing');
const {currentPaymentIsValid}=require('../api/_lib/spotlight-payment');
const {invoiceTerms}=require('../api/_lib/spotlight-custom-plans');
const plan={key:'hare-250-v1',subscription:'sub_fixture',customer:'cus_fixture',price:'price_custom',invoice:'in_supplement',amount:25000,autoUpgrade:true,initialInvoice:'in_initial',item:'si_fixture',periodStart:Math.floor(Date.now()/1000)-3600,periodEnd:Math.floor(Date.now()/1000)+2000000};
process.env.SPOTLIGHT_CUSTOM_PLANS_JSON=JSON.stringify([plan]);
function fixture(){
 const price={id:'price_base',unit_amount:10000,currency:'usd',type:'recurring',active:true,livemode:true,recurring:{interval:'month',interval_count:1,usage_type:'licensed'}};
 const sub={id:plan.subscription,customer:plan.customer,livemode:true,status:'active',pause_collection:null,metadata:{spotlight_review_status:'approved'},items:{has_more:false,data:[{id:plan.item,quantity:1,price,current_period_start:plan.periodStart,current_period_end:plan.periodEnd}]},latest_invoice:{id:plan.initialInvoice}};
 const inv={id:plan.invoice,customer:plan.customer,livemode:true,status:'paid',currency:'usd',amount_due:15000,amount_paid:15000,total:15000,amount_remaining:0,lines:{has_more:false,data:[{amount:15000}]}};
 const calls=[];const state={sub,inv,refunds:[],disputed:false,additional:[],error:false};
 const stripe={
 subscriptions:{retrieve:async()=>structuredClone(state.sub),list:async()=>({has_more:false,data:[state.sub,...state.additional]}),update:async(id,body,opts)=>{calls.push({id,body,opts});if(state.error)throw Error('temporary Stripe failure');state.sub.items.data[0].price={...price,id:plan.price,unit_amount:25000};return structuredClone(state.sub)}},
 invoices:{retrieve:async()=>structuredClone(state.inv)},prices:{retrieve:async()=>({...price,id:plan.price,unit_amount:25000})},
 invoicePayments:{list:async({invoice})=>{const amount=invoice===plan.invoice?15000:invoice==='in_renewal'?25000:10000;return {has_more:false,data:[{invoice,status:'paid',livemode:true,amount_paid:amount,currency:'usd',payment:{type:'payment_intent',payment_intent:{id:'pi_'+invoice,livemode:true,status:'succeeded',amount,amount_received:amount,currency:'usd',customer:plan.customer,latest_charge:'ch_'+invoice}}}]}}},
 charges:{retrieve:async(charge)=>{const invoice=charge.slice(3);const amount=invoice===plan.invoice?15000:invoice==='in_renewal'?25000:10000;return {id:charge,payment_intent:'pi_'+invoice,customer:plan.customer,livemode:true,status:'succeeded',paid:true,captured:true,amount,amount_captured:amount,currency:'usd',amount_refunded:0,refunded:false,disputed:state.disputed}}},
 refunds:{list:async()=>({has_more:false,data:state.refunds})}
 };
 const event={type:'invoice.paid',livemode:true,data:{object:{id:plan.invoice}}};
 const run=(e=event)=>reconcileCustomBilling(stripe,{live:true,priceId:'price_base'},e,()=>true);
 return {state,stripe,run,event,calls};
}
test('paid extra replaces existing item once with no proration or anchor reset',async()=>{const f=fixture();await f.run();await f.run();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{items:[{id:plan.item,price:plan.price,quantity:1}],proration_behavior:'none',payment_behavior:'error_if_incomplete'});assert.equal(f.state.sub.latest_invoice.id,plan.initialInvoice);assert.equal(f.state.sub.items.data.length,1);});
test('both payment-before-approval and approval-before-payment converge safely',async()=>{
 const f=fixture();f.state.sub.metadata.spotlight_review_status='pending';f.state.sub.pause_collection={behavior:'void'};await f.run();assert.equal(f.calls.length,0);f.state.sub.metadata.spotlight_review_status='approved';f.state.sub.pause_collection=null;await f.run({type:'customer.subscription.updated',livemode:true,data:{object:{id:plan.subscription}}});assert.equal(f.calls.length,1);
 const g=fixture();g.state.inv.status='draft';await g.run();assert.equal(g.calls.length,0);g.state.inv.status='paid';await g.run();assert.equal(g.calls.length,1);
});
test('unpaid, canceled, held and foreign events cannot activate',async()=>{for(const edit of [f=>f.state.inv.status='open',f=>f.state.sub.status='canceled',f=>f.state.sub.cancel_at_period_end=true,f=>f.state.sub.pause_collection={behavior:'void'},f=>f.event.data.object.id='in_other',f=>f.event.livemode=false]){const f=fixture();edit(f);await f.run();assert.equal(f.calls.length,0)}});
test('refund, dispute, customer/period mismatch and duplicate subscription fail closed',async()=>{for(const edit of [f=>f.state.disputed=true,f=>f.state.inv.amount_paid=10000,f=>f.state.inv.customer='cus_other',f=>f.state.sub.items.data[0].current_period_end++,f=>f.state.additional=[{id:'sub_other',status:'active'}],f=>f.state.sub.schedule='sched_other',f=>f.state.refunds=[{status:'succeeded',amount:15000,currency:'usd',payment_intent:'pi_in_supplement'}]]){const f=fixture();edit(f);await assert.rejects(f.run());assert.equal(f.calls.length,0)}});
test('Stripe failure retries with same idempotency key',async()=>{const f=fixture();f.state.error=true;await assert.rejects(f.run());f.state.error=false;await f.run();assert.equal(f.calls[0].opts.idempotencyKey,f.calls[1].opts.idempotencyKey)});
test('first period validates $100 plus $150; subsequent renewal validates $250',async()=>{const f=fixture();await f.run();assert.equal(invoiceTerms(f.state.sub,{live:true,priceId:'price_base'}).amount,10000);assert.equal(await currentPaymentIsValid(f.stripe,f.state.sub,{live:true,priceId:'price_base'}),true);f.state.inv.status='open';assert.equal(await currentPaymentIsValid(f.stripe,f.state.sub,{live:true,priceId:'price_base'}),false);f.state.sub.latest_invoice={id:'in_renewal'};assert.equal(await currentPaymentIsValid(f.stripe,f.state.sub,{live:true,priceId:'price_base'}),true);f.state.disputed=true;assert.equal(await currentPaymentIsValid(f.stripe,f.state.sub,{live:true,priceId:'price_base'}),false)});
