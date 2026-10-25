'use strict';
const core=require('./sponsorship-core');
const schedule=require('./sponsorship-schedule');
const {emailJobs}=require('./sponsorship-emails');
const DEFAULT_CONFIG={enabled:false,timeZone:'America/Los_Angeles',calendarId:'chrisserknee@gmail.com',blockCalendarIds:['chrisserknee@gmail.com'],
    package:null,packages:[],terms:null,windows:[],weeklyWindows:[],bufferBefore:30,bufferAfter:30,leadHours:24,revision:0};
const freshState=()=>({schema:2,config:{...DEFAULT_CONFIG},orders:{},holds:{},limits:{},outbox:{}});
const orderFor=(s,id)=>{const r=s.orders[id];if(!r)core.fail('Request not found.',404);return r;};
function authenticate(s,b){const r=orderFor(s,b.id);if(!core.validToken(b.token,r.tokenHash))core.fail('Request not found.',404);return r;}
function queue(s,order,type,now){for(const job of emailJobs(order,type,now))if(!s.outbox[job.id])s.outbox[job.id]=job;}
function validateConfig(b,previous){
    if(!b||typeof b!=='object'||Array.isArray(b))core.fail('Invalid settings.');
    const c={...DEFAULT_CONFIG,...Object.fromEntries(Object.keys(DEFAULT_CONFIG).filter(k=>k in b).map(k=>[k,b[k]])),revision:previous.revision+1};
    try{new Intl.DateTimeFormat('en',{timeZone:c.timeZone});}catch{core.fail('Choose a valid timezone.');}
    c.calendarId=core.field(c.calendarId,'calendar ID',300);
    if(!Array.isArray(c.blockCalendarIds)||!c.blockCalendarIds.length||c.blockCalendarIds.length>10)core.fail('Choose calendars to check.');
    c.blockCalendarIds=c.blockCalendarIds.map(id=>core.field(id,'calendar ID',300));
    if(!c.blockCalendarIds.includes(c.calendarId))c.blockCalendarIds.push(c.calendarId);
    for(const key of ['bufferBefore','bufferAfter','leadHours'])if(!Number.isInteger(c[key])||c[key]<0||c[key]>168)core.fail('Invalid buffer or notice period.');
    c.package=c.package?core.packageConfig(c.package):null;
    if(!Array.isArray(c.packages)||c.packages.length>8)core.fail('Choose up to eight package options.');
    c.packages=c.packages.map(core.packageConfig);
    if(new Set(c.packages.map(p=>p.id)).size!==c.packages.length)core.fail('Each package needs a unique ID.');
    c.terms=c.terms?{version:core.field(c.terms.version,'agreement version',80),provider:core.field(c.terms.provider,'legal business name',200),text:core.field(c.terms.text,'agreement terms',20000),exclusiveText:core.field(c.terms.exclusiveText||'','exclusivity terms',15000,false),approved:c.terms.approved===true}:null;
    c.windows=schedule.validateWindows(c.windows,c.timeZone);
    c.weeklyWindows=schedule.validateWeekly(c.weeklyWindows);
    c.enabled=c.enabled===true;
    if(c.enabled&&(!(c.packages.length||c.package)||!(c.windows.length||c.weeklyWindows.length)||!c.terms?.approved))core.fail('Set your package, filming hours, and approved agreement terms before opening requests.');
    if(c.enabled&&c.packages.some(p=>p.exclusive)&&!c.terms.exclusiveText)core.fail('Add the exclusivity agreement before offering exclusive plans.');
    return c;
}
const packagesFor=c=>c.packages?.length?c.packages:(c.package?[c.package]:[]);
function choosePackage(c,id){const options=packagesFor(c),p=options.find(p=>p.id===id)||(!id&&options.length===1?options[0]:null);if(!p)core.fail('Choose a current package.');return p;}
const normalizeScope=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const activeExclusive=(r,now)=>r.package.exclusive&&['accepting','approved','signed','paid'].includes(r.status)&&(!r.exclusivity?.endsAt||r.exclusivity.endsAt>now);
function createWorkflow({store,calendar,payments,now=Date.now,ready=()=>true,recurringReady=()=>false}){
    async function available(date,ignoreId='',packageId){
        const s=await store.read(),c=s.config;
        if(!c.enabled||!ready())core.fail('Online booking is being set up. Please contact Chris.',503);
        const selected=choosePackage(c,packageId);
        if(!schedule.offeredDates(c,now()).includes(date))return {date,timeZone:c.timeZone,slots:[],revision:c.revision};
        const start=schedule.localTimeToUtc(date,'00:00',c.timeZone);
        const busy=await calendar.busy(c,start-86400000,start+172800000,ignoreId);
        return {date,timeZone:c.timeZone,slots:schedule.buildSlots({...c,package:selected},date,busy,s.holds,now(),ignoreId),revision:c.revision};
    }
    async function accept(id,review={}){
        let s=await store.read(),r=orderFor(s,id);
        if(['approved','signed','paid'].includes(r.status))return core.publicRecord(r);
        if(!ready())core.fail('Connect calendar and payments before accepting requests.',503);
        if(r.package.billing&&r.package.billing!=='once'&&!recurringReady())core.fail('Recurring billing is awaiting sandbox verification. This request is saved; no subscription or charge has been created.',503);
        if(!['pending','accepting'].includes(r.status))core.fail('This request cannot be accepted.',409);
        if(!s.config.terms?.approved)core.fail('Approve the agreement terms in settings first.',409);
        if(r.status==='pending'){
            const proposed={...r.slot,bufferBefore:s.config.bufferBefore,bufferAfter:s.config.bufferAfter};
            const busy=await calendar.busy(s.config,schedule.slotInterval(proposed).start,schedule.slotInterval(proposed).end);
            if(busy.some(b=>schedule.overlaps(b,schedule.slotInterval(proposed))))core.fail('Google Calendar now has a conflict. Ask the business for another time.',409);
            await store.change(next=>{
                const current=orderFor(next,id);if(current.status!=='pending')return;
                if(!next.config.terms?.approved)core.fail('Approve the agreement terms first.',409);
                const competitors=Object.values(next.orders).filter(o=>o.id!==id&&activeExclusive(o,now()));
                let exclusivity=current.exclusivity||null;
                if(current.package.exclusive){
                    if(!next.config.terms.exclusiveText)core.fail('Add the exclusivity agreement first.',409);
                    exclusivity={category:core.field(review.category||current.category,'reserved category',200),market:core.field(review.market||current.market,'reserved market',200),exceptions:core.field(review.exceptions||'None','exclusivity exceptions',1500),reviewedAt:now(),starts:'Initial paid service period',endsAt:null};
                }
                if((current.package.exclusive||competitors.length)&&review.conflictsReviewed!==true)core.fail('Review category, market, and existing sponsorship commitments before acceptance.',409);
                const category=exclusivity?.category||current.category,market=exclusivity?.market||current.market;
                if(competitors.some(o=>normalizeScope(o.exclusivity?.category)===normalizeScope(category)&&normalizeScope(o.exclusivity?.market)===normalizeScope(market)))core.fail('An existing exclusive partner reserves this category and market. Review the conflict before proceeding.',409);
                // Check that the requested time is still inside the owner's preset hours.
                const c={...next.config,package:current.package,leadHours:0};
                const date=schedule.localDate(current.slot.start,c.timeZone);
                const slot=schedule.buildSlots(c,date,[],next.holds,now()).find(slot=>slot.start===current.slot.start);
                if(!slot)core.fail('This time is no longer available in your filming schedule.',409);
                next.holds[id]=slot;
                next.orders[id]={...current,slot,exclusivity,status:'accepting',calendarId:next.config.calendarId,blockCalendarIds:next.config.blockCalendarIds,
                    agreement:core.agreement({...current,slot,exclusivity},next.config.terms,now()),acceptedAt:now(),conflictsReviewed:review.conflictsReviewed===true};
            });
        }
        s=await store.read();r=orderFor(s,id);
        if(r.status!=='accepting')return core.publicRecord(r);
        // Idempotent calendar event ID permits retry after a lost response.
        try{await calendar.hold(r);}
        catch(e){
            if(e.code===409)await store.change(next=>{if(orderFor(next,id).status==='accepting'){next.orders[id]={...next.orders[id],status:'pending',agreement:null};delete next.holds[id];}});
            throw e;
        }
        await store.change(next=>{
            const current=orderFor(next,id);if(current.status!=='accepting')return;
            next.orders[id]={...current,status:'approved',calendarHeld:true};queue(next,next.orders[id],'approved',now());
        });
        return core.publicRecord(orderFor(await store.read(),id));
    }
    async function pay(b){
        let r=authenticate(await store.read(),b);
        if(r.status==='paid')return {paid:true};
        if(r.status!=='signed'||!r.signature)core.fail('Sign the agreement before opening payment.',409);
        if(r.package.billing!=='once'&&r.package.billing&&!recurringReady())core.fail('Recurring billing is awaiting sandbox verification.',503);
        if(r.invoice){
            const invoice=await payments.retrieve(r.invoice.id);
            if(invoice.status==='paid'){await paymentReceived(invoice);return {paid:true};}
            if(invoice.status==='open'){
                if(r.package.billing&&r.package.billing!=='once')await payments.verifyInitialPlan(r);
                await calendar.verifyHold(r);return paymentLink(r,invoice);
            }
            if(invoice.status!=='draft')core.fail('This invoice needs Chris’s attention.',409);
        }
        await calendar.verifyHold(r);
        // IDs are saved after each external operation. Refuse to blindly recreate
        // a lost Stripe response after its idempotency retention window.
        await store.change(s=>{const current=orderFor(s,r.id);if(!current.billingStartedAt)current.billingStartedAt=now();});
        r=orderFor(await store.read(),r.id);
        const save=async changes=>store.change(s=>{Object.assign(orderFor(s,r.id),changes);});
        const invoice=await payments.issue(r,save,now());
        await save({invoice:{id:invoice.id,number:invoice.number}});
        if(invoice.status==='paid'){await paymentReceived(invoice);return {paid:true};}
        return paymentLink(orderFor(await store.read(),r.id),invoice);
    }
    function paymentLink(r,invoice){
        let url;try{url=new URL(invoice.hosted_invoice_url);}catch{core.fail('The invoice link needs attention.',503);}
        const identity=r.package.billing&&r.package.billing!=='once'?require('./sponsorship-recurring').invoiceIdentity(invoice):{metadata:invoice.metadata};
        if(r.stripeCustomerId&&invoice.customer!==r.stripeCustomerId)core.fail('Invoice customer needs review before payment.',409);
        if(r.stripeSubscriptionId&&identity.subscriptionId!==r.stripeSubscriptionId)core.fail('Invoice subscription needs review before payment.',409);
        if(invoice.id!==r.invoice?.id||identity.metadata?.sponsorshipId!==r.id||identity.metadata?.agreementHash!==r.agreement.hash||invoice.currency!=='usd'||invoice.total!==r.package.amount||invoice.status!=='open'||url.protocol!=='https:'||url.hostname!=='invoice.stripe.com')core.fail('This invoice needs review before payment.',409);
        return {url:url.href};
    }
    async function paymentReceived(invoice){
        const id=require('./sponsorship-recurring').invoiceIdentity(invoice).metadata?.sponsorshipId;if(!id)return;
        await store.change(s=>{const r=orderFor(s,id);
            // The provider saves this ID before finalizing. A paid webhook can
            // arrive before checkout saves the public invoice reference.
            const candidate=!r.invoice&&r.stripeInitialInvoiceId===invoice.id?{...r,invoice:{id:invoice.id,number:invoice.number}}:r;
            const updated=core.paidRecord(candidate,invoice,now());delete updated.reconciliationIssue;s.orders[id]=updated;
            if(r.payments?.length&&updated.payments?.length>r.payments.length)queue(s,updated,'renewed',now());
            if(updated.exclusivity&&updated.billing?.endsAt)updated.exclusivity.endsAt=updated.billing.endsAt;
        });
        const r=orderFor(await store.read(),id);
        if(r.calendarConfirmed)return;
        // If calendar confirmation fails, Stripe retries this webhook. A scheduled
        // reconciler also repairs it; paid status is never reverted or charged again.
        try{await calendar.confirm(r);}catch(e){
            await store.change(s=>{queue(s,s.orders[id],'calendar-review',now());});throw e;
        }
        await store.change(s=>{s.orders[id].calendarConfirmed=true;queue(s,s.orders[id],'paid',now());});
    }
    async function handle(b){
        if(b.op==='draft-settings')return {config:require('./sponsorship-presets').draft,note:'Draft proposal. Monthly Partner ($1,500) and Monthly Campaign ($2,500) are proposed; review package scope and agreements before opening booking.'};
        if(b.op==='settings')return {config:(await store.read()).config,integrationsReady:ready(),recurringReady:recurringReady()};
        if(b.op==='save-settings'){
            const current=await store.read();if(b.revision!==current.config.revision)core.fail('Settings changed. Reload before saving.',409);
            const c=validateConfig(b.config,current.config);
            if(c.enabled&&!ready())core.fail('Connect calendar and payments before opening requests.',503);
            if(c.enabled&&packagesFor(c).some(p=>p.billing!=='once')&&!recurringReady())core.fail('Complete recurring billing sandbox verification before opening monthly packages.',503);
            await store.change(s=>{if(s.config.revision!==b.revision)core.fail('Settings changed. Reload before saving.',409);s.config=c;});return {config:c};
        }
        if(b.op==='offer'){
            const c=(await store.read()).config;
            return {open:c.enabled&&ready(),package:packagesFor(c)[0]||null,packages:packagesFor(c),timeZone:c.timeZone,dates:schedule.offeredDates(c,now()),weeklyWindows:c.weeklyWindows,revision:c.revision};
        }
        if(b.op==='availability')return available(b.date,'',b.packageId);
        if(b.op==='submit'){
            if(!/^[a-f0-9]{64}$/.test(b.token||''))core.fail('Invalid request key.');
            const id=core.hash(b.token).slice(0,32),initial=await store.read();
            if(initial.orders[id])return {id,status:initial.orders[id].status};
            const data=core.intake(b),c=initial.config;
            if(!c.enabled||!ready())core.fail('Requests are not open yet.',503);
            const selected=choosePackage(c,b.packageId);
            if(c.packages?.length){data.category=core.field(b.category,'business category',200);data.market=core.field(b.market,'business market',200);}
            const day=schedule.localDate(b.slotStart,c.timeZone),availability=await available(day,'',selected.id);
            const slot=availability.slots.find(s=>s.start===b.slotStart);if(!slot)core.fail('That time is no longer available. Choose another time.',409);
            await store.change(s=>{
                if(s.orders[id])return;
                if(c.revision!==s.config.revision||b.offerRevision!==c.revision)core.fail('Package or availability changed. Review the updated package before submitting.',409);
                if(Object.values(s.holds).some(h=>schedule.overlaps(schedule.slotInterval(h),schedule.slotInterval(slot))))core.fail('That time was just reserved. Pick another.',409);
                if(Object.keys(s.orders).length>=2000)core.fail('Please contact Chris to book.',503);
                const key=String(b.clientKey||'');if(!/^[a-f0-9]{64}$/.test(key))core.fail('Invalid request.');
                const hour=Math.floor(now()/3600000),lim=s.limits.hour===hour?s.limits:{hour,total:0,clients:{}};
                if(lim.total>=100||(lim.clients[key]||0)>=5)core.fail('Too many requests. Please try later.',429);
                lim.total++;lim.clients[key]=(lim.clients[key]||0)+1;s.limits=lim;
                s.orders[id]={...data,id,token:b.token,tokenHash:core.hash(b.token),status:'pending',slot,package:selected,createdAt:now(),offerRevision:c.revision};
                queue(s,s.orders[id],'requested',now());
            });return {id,status:'pending'};
        }
        if(b.op==='list'){
            const s=await store.read();return {orders:Object.values(s.orders).map(({token,tokenHash,...r})=>r).sort((a,b)=>b.createdAt-a.createdAt),
                notifications:Object.values(s.outbox).map(({id,type,state,attempts,lastError})=>({id,type,state,attempts,lastError}))};
        }
        if(b.op==='approve')return accept(b.id,b);
        if(b.op==='decline'){
            await store.change(s=>{const r=orderFor(s,b.id);if(r.status==='declined')return;if(r.status!=='pending')core.fail('Only pending requests can be declined.',409);
                s.orders[b.id]={...r,status:'declined',declineReason:core.field(b.reason||'','decline reason',1500,false),declinedAt:now()};queue(s,s.orders[b.id],'declined',now());
            });return core.publicRecord(orderFor(await store.read(),b.id));
        }
        if(b.op==='status')return core.publicRecord(authenticate(await store.read(),b));
        if(b.op==='sign'){
            await store.change(s=>{const r=authenticate(s,b);s.orders[b.id]=core.sign(r,b,now());});return core.publicRecord(orderFor(await store.read(),b.id));
        }
        if(b.op==='checkout')return pay(b);
        if(b.op==='billing-invoice'){
            const r=authenticate(await store.read(),b);
            if(r.status!=='paid'||!r.stripeSubscriptionId)core.fail('No recurring invoice is available.',409);
            const sub=await payments.retrieveSubscription(r.stripeSubscriptionId),invoice=await payments.retrieve(typeof sub.latest_invoice==='string'?sub.latest_invoice:sub.latest_invoice?.id);
            const identity=require('./sponsorship-recurring').invoiceIdentity(invoice);
            if(identity.subscriptionId!==r.stripeSubscriptionId)core.fail('Invoice identity needs review.',409);
            if(invoice.status==='paid')return {paid:true};
            return paymentLink({...r,invoice:{id:invoice.id}},invoice);
        }
        if(b.op==='cancel-renewal'){
            const r=authenticate(await store.read(),b);
            if(b.confirm!==true)core.fail('Confirm cancellation of future monthly renewals.');
            const billing=await payments.cancelRenewal(r);
            await store.change(s=>{const current=orderFor(s,r.id);current.billing={...current.billing,...billing};if(current.exclusivity)current.exclusivity.endsAt=billing.periodEnd;queue(s,current,'renewal-canceled',now());});
            return core.publicRecord(orderFor(await store.read(),r.id));
        }
        core.fail('Unknown action.');
    }
    async function reconcile(){
        const s=await store.read(),deadline=Date.now()+45000;
        // Oldest checked first, so a batch of unpaid invoices cannot permanently
        // hide later payments. Never create invoices or charge during recovery.
        const pending=Object.values(s.orders).filter(r=>r.status==='accepting'||(r.status==='paid'&&!r.calendarConfirmed)
            ||(r.status==='signed'&&(r.invoice?.id||r.stripeInitialInvoiceId)))
            .sort((a,b)=>(a.reconciledAt||0)-(b.reconciledAt||0)).slice(0,20);
        for(const r of pending){
            if(Date.now()>=deadline)break;
            try{
                if(r.status==='accepting')await accept(r.id);
                else{
                    const invoice=await payments.retrieve(r.invoice?.id||r.stripeInitialInvoiceId);
                    const identity=require('./sponsorship-recurring').invoiceIdentity(invoice);
                    if(invoice.id!==(r.invoice?.id||r.stripeInitialInvoiceId)||identity.metadata?.sponsorshipId!==r.id)
                        core.fail('Invoice identity needs owner review.',409);
                    if(invoice.status==='paid')await paymentReceived(invoice);
                    else if(!['draft','open'].includes(invoice.status))core.fail('Invoice needs owner review.',409);
                }
                await store.change(next=>{const current=orderFor(next,r.id);current.reconciledAt=now();current.reconciliationFailures=0;delete current.reconciliationIssue;});
            }catch{
                await store.change(next=>{const current=orderFor(next,r.id);current.reconciledAt=now();
                    current.reconciliationFailures=(current.reconciliationFailures||0)+1;
                    current.reconciliationIssue='Automatic booking recovery could not finish. Check Stripe payment status and the reserved calendar event before taking action.';
                    if(current.reconciliationFailures>=3)queue(next,current,'recovery-review',now());
                });
            }
        }
    }
    async function subscriptionChanged(sub){
        const id=sub.metadata?.sponsorshipId;if(!id)return;
        const {publicBilling}=require('./sponsorship-recurring');
        await store.change(s=>{const r=orderFor(s,id);if(r.stripeSubscriptionId!==sub.id||sub.metadata.agreementHash!==r.agreement?.hash)core.fail('Subscription does not match this booking.',409);
            const data=publicBilling(sub);r.billing={...r.billing,...data,endsAt:r.billing?.endsAt||null};
            if(r.exclusivity&&sub.cancel_at_period_end)r.exclusivity.endsAt=data.periodEnd;
            if(['canceled','incomplete_expired'].includes(sub.status)&&r.exclusivity)r.exclusivity.endsAt=Math.min(r.exclusivity.endsAt||now(),now());
            if(['past_due','unpaid'].includes(sub.status))queue(s,r,'billing-review',now());
        });
    }
    return {handle,paymentReceived,subscriptionChanged,reconcile};
}
module.exports={createWorkflow,freshState,validateConfig,DEFAULT_CONFIG};
