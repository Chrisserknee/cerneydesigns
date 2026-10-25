'use strict';
const core=require('./sponsorship-core');
const objectId=value=>typeof value==='string'?value:value?.id;
function subscriptionDetails(invoice){
    return invoice.parent?.subscription_details||invoice.subscription_details||{};
}
function invoiceIdentity(invoice){
    const details=subscriptionDetails(invoice);
    return {subscriptionId:objectId(details.subscription||invoice.subscription),metadata:details.metadata||invoice.metadata||{}};
}
function publicBilling(subscription,schedule){
    const item=subscription.items?.data?.[0];
    return {status:subscription.status,periodStart:(item?.current_period_start||subscription.current_period_start)*1000,
        periodEnd:(item?.current_period_end||subscription.current_period_end)*1000,
        cancelAtPeriodEnd:subscription.cancel_at_period_end===true,
        endsAt:schedule?.end_behavior==='cancel'?schedule.phases?.at(-1)?.end_date*1000:null};
}
// Stripe anchors monthly billing to the original day, clamping only months
// without that day (Jan 31 → Feb 28 → Mar 31), in UTC.
function monthBoundary(seconds,months){
    const start=new Date(seconds*1000),result=new Date(seconds*1000),day=start.getUTCDate();
    result.setUTCDate(1);result.setUTCMonth(start.getUTCMonth()+months);
    const last=new Date(Date.UTC(result.getUTCFullYear(),result.getUTCMonth()+1,0)).getUTCDate();
    result.setUTCDate(Math.min(day,last));return result.getTime()/1000;
}
function createRecurringPayments(request){
    async function validateInitialPlan(r,schedule,sub){
        const fixed=r.package.billing==='three_month',phase=schedule.phases?.[0],item=sub.items?.data?.[0];
        const matches=metadata=>metadata?.sponsorshipId===r.id&&metadata?.agreementHash===r.agreement.hash;
        const reject=()=>core.fail('The billing plan changed or its first service period ended. Chris needs to review it before payment.',409);
        if(schedule.id!==r.stripeScheduleId||objectId(schedule.customer)!==r.stripeCustomerId||!matches(schedule.metadata)
            ||schedule.status!=='active'||schedule.phases?.length!==1||schedule.end_behavior!==(fixed?'cancel':'release')
            ||objectId(schedule.subscription)!==sub.id||sub.id!==r.stripeSubscriptionId||objectId(sub.customer)!==r.stripeCustomerId
            ||objectId(sub.schedule)!==schedule.id||!matches(sub.metadata)||!matches(phase?.metadata)
            ||!['active','incomplete','past_due'].includes(sub.status)||sub.cancel_at_period_end||sub.pause_collection
            // Stripe sets cancel_at when a canceling schedule enters its final
            // phase. Our fixed plan has one phase, so its exact end is expected.
            ||(sub.cancel_at&&(!fixed||sub.cancel_at!==phase?.end_date))
            ||!Number.isSafeInteger(phase?.start_date)||phase.end_date!==monthBoundary(phase.start_date,fixed?3:1)
            ||phase.trial_end||phase.trial||phase.discounts?.length||phase.add_invoice_items?.length||phase.default_tax_rates?.length
            ||phase.automatic_tax?.enabled||schedule.default_settings?.automatic_tax?.enabled||sub.automatic_tax?.enabled
            ||sub.discounts?.length||sub.default_tax_rates?.length||sub.pending_update||sub.items?.has_more||sub.items?.data?.length!==1
            ||phase.items?.length!==1||phase.items[0].quantity!==1||item?.quantity!==1
            ||phase.items[0].discounts?.length||phase.items[0].tax_rates?.length||item.discounts?.length||item.tax_rates?.length
            ||item.current_period_start!==phase.start_date||item.current_period_end!==monthBoundary(phase.start_date,1)
            ||objectId(phase.items[0].price)!==objectId(item.price))reject();
        const price=typeof item.price==='object'?item.price:await request('prices/'+encodeURIComponent(item.price));
        if(!price||price.currency!=='usd'||price.unit_amount!==r.package.amount||price.billing_scheme!=='per_unit'
            ||price.recurring?.interval!=='month'||price.recurring.interval_count!==1||price.recurring.usage_type!=='licensed'
            ||price.transform_quantity||objectId(price.product)!==r.stripeProductId)reject();
        return {...publicBilling(sub,schedule),startedAt:phase.start_date*1000};
    }
    async function verifyInitialPlan(r){
        if(!r.stripeScheduleId||!r.stripeSubscriptionId)core.fail('Billing setup needs review.',409);
        const schedule=await request('subscription_schedules/'+encodeURIComponent(r.stripeScheduleId));
        const sub=await request('subscriptions/'+encodeURIComponent(r.stripeSubscriptionId));
        return validateInitialPlan(r,schedule,sub);
    }
    async function issue(r,save,now){
        if(!r.signature?.recurringConsent)core.fail('Recurring billing consent is required.',409);
        const canCreate=()=>{if(now-r.billingStartedAt>23*3600000)core.fail('Billing setup needs review before retrying. Contact Chris.',409);};
        const fixed=r.package.billing==='three_month',meta={'metadata[sponsorshipId]':r.id,'metadata[agreementHash]':r.agreement.hash};
        let customer=r.stripeCustomerId,product=r.stripeProductId,schedule;
        // A separate customer per signed booking prevents accidentally charging
        // an unrelated saved payment method or carrying unrelated invoice items.
        if(!customer){canCreate();customer=(await request('customers',{email:r.email,name:r.business,...meta},r.id+'-customer')).id;await save({stripeCustomerId:customer});}
        if(!product){canCreate();product=(await request('products',{name:r.package.title,...meta},r.id+'-product')).id;await save({stripeProductId:product});}
        if(r.stripeScheduleId)schedule=await request('subscription_schedules/'+r.stripeScheduleId);
        else{
            canCreate();schedule=await request('subscription_schedules',{customer,start_date:'now',end_behavior:fixed?'cancel':'release',...meta,
                'default_settings[collection_method]':'charge_automatically','default_settings[automatic_tax][enabled]':'false',
                'default_settings[description]':core.billingDescription(r.package),
                'default_settings[invoice_settings][footer]':'Signed agreement: '+r.agreement.hash,
                'phases[0][duration][interval]':'month','phases[0][duration][interval_count]':fixed?'3':'1',
                'phases[0][items][0][price_data][currency]':'usd','phases[0][items][0][price_data][unit_amount]':String(r.package.amount),
                'phases[0][items][0][price_data][product]':product,'phases[0][items][0][price_data][recurring][interval]':'month',
                'phases[0][items][0][quantity]':'1','phases[0][proration_behavior]':'none',
                'phases[0][metadata][sponsorshipId]':r.id,'phases[0][metadata][agreementHash]':r.agreement.hash},r.id+'-schedule');
            await save({stripeScheduleId:schedule.id,stripeSubscriptionId:objectId(schedule.subscription)});
        }
        const subscriptionId=objectId(schedule.subscription)||r.stripeSubscriptionId;
        if(!subscriptionId)core.fail('Stripe is still preparing the subscription. Try again shortly.',503);
        const sub=await request('subscriptions/'+subscriptionId);
        const billing=await validateInitialPlan({...r,stripeCustomerId:customer,stripeProductId:product,stripeScheduleId:r.stripeScheduleId||schedule.id,stripeSubscriptionId:r.stripeSubscriptionId||subscriptionId},schedule,sub);
        await request('subscriptions/'+subscriptionId,{'payment_settings[save_default_payment_method]':'on_subscription'},r.id+'-save-payment-method');
        await save({stripeSubscriptionId:subscriptionId,billing});
        // Pin the first invoice before finalization. A retry must never pick up
        // a later renewal from latest_invoice after a partial setup failure.
        let initialInvoiceId=r.invoice?.id||r.stripeInitialInvoiceId;
        if(!initialInvoiceId){canCreate();initialInvoiceId=objectId(sub.latest_invoice);}
        if(!initialInvoiceId)core.fail('Stripe is still preparing the first invoice.',503);
        let invoice=await request('invoices/'+initialInvoiceId);
        const initialIdentity=invoiceIdentity(invoice);
        if(invoice.billing_reason!=='subscription_create'||invoice.customer!==customer||initialIdentity.subscriptionId!==subscriptionId||initialIdentity.metadata.sponsorshipId!==r.id||initialIdentity.metadata.agreementHash!==r.agreement.hash||invoice.currency!=='usd'||invoice.total!==r.package.amount)core.fail('The initial invoice needs review before payment.',409);
        await save({stripeInitialInvoiceId:invoice.id});
        if(invoice.status==='draft'){
            // Future subscription invoices auto-charge. The first stays under
            // explicit customer control on Stripe's hosted invoice page.
            await request('invoices/'+invoice.id,{auto_advance:'false',...meta,description:core.billingDescription(r.package)},r.id+'-initial-invoice');
            invoice=await request('invoices/'+invoice.id+'/finalize',{auto_advance:'false'},r.id+'-finalize');
        }
        const identity=invoiceIdentity(invoice);
        if(identity.subscriptionId!==subscriptionId||identity.metadata.sponsorshipId!==r.id||identity.metadata.agreementHash!==r.agreement.hash||invoice.currency!=='usd'||invoice.total!==r.package.amount||!['open','paid'].includes(invoice.status))core.fail('Recurring invoice does not match the signed plan.',409);
        return invoice;
    }
    async function retrieveSubscription(id){return request('subscriptions/'+encodeURIComponent(id));}
    async function cancelRenewal(r){
        if(r.package.billing!=='monthly'||!r.stripeSubscriptionId)core.fail('This is not a month-to-month plan. Contact Chris about the fixed commitment.',409);
        let sub=await retrieveSubscription(r.stripeSubscriptionId);
        if(sub.metadata?.sponsorshipId!==r.id||sub.metadata?.agreementHash!==r.agreement.hash)core.fail('Subscription identity needs review.',409);
        if(sub.schedule){await request('subscription_schedules/'+objectId(sub.schedule)+'/release',{},r.id+'-release-for-cancellation');}
        if(!['canceled','incomplete_expired'].includes(sub.status))sub=await request('subscriptions/'+r.stripeSubscriptionId,{cancel_at_period_end:'true'},r.id+'-cancel-renewal');
        return publicBilling(sub);
    }
    return {issue,retrieveSubscription,cancelRenewal,verifyInitialPlan};
}
module.exports={createRecurringPayments,invoiceIdentity,publicBilling,monthBoundary};
