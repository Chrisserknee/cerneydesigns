'use strict';
const core=require('./sponsorship-core');
const {slotInterval,localTimeToUtc,overlaps}=require('./sponsorship-schedule');
const SITE='https://cerneyselects.com';
function createCalendar({auth,fetchImpl=fetch}){
    async function request(path,{method='GET',body}={}){
        const client=await auth.getClient(),token=await client.getAccessToken();
        const r=await fetchImpl('https://www.googleapis.com/calendar/v3/'+path,{method,headers:{Authorization:'Bearer '+token.token,'Content-Type':'application/json'},
            ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
        if(r.status===404)return null;
        if(!r.ok)throw Object.assign(new Error('Calendar connection needs attention.'),{code:r.status===409?409:503});
        return r.status===204?{}:r.json();
    }
    const path=id=>'calendars/'+encodeURIComponent(id)+'/events';
    const eventId=id=>'sponsor'+id;
    async function busy(config,start,end,ignoreId=''){
        const result=[];
        // Personal calendars need free/busy access only. Event details are read
        // solely from the dedicated booking calendar to exclude our own hold.
        const freeBusyIds=config.blockCalendarIds.filter(id=>!ignoreId||id!==config.calendarId);
        if(freeBusyIds.length){
            const d=await request('freeBusy',{method:'POST',body:{timeMin:new Date(start).toISOString(),timeMax:new Date(end).toISOString(),items:freeBusyIds.map(id=>({id}))}});
            for(const id of freeBusyIds){const c=d?.calendars?.[id];if(!c||c.errors?.length||!Array.isArray(c.busy))core.fail('Could not check all calendars.',503);
                for(const b of c.busy){const start=Date.parse(b.start),end=Date.parse(b.end);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)core.fail('Invalid calendar availability.',503);result.push({start,end});}
            }
        }
        if(ignoreId){
            const id=config.calendarId;
            let pageToken='';
            do{
                const q=new URLSearchParams({timeMin:new Date(start).toISOString(),timeMax:new Date(end).toISOString(),singleEvents:'true',maxResults:'2500',...(pageToken?{pageToken}:{})});
                const d=await request(path(id)+'?'+q);if(!d||!Array.isArray(d.items))core.fail('Calendar unavailable.',503);
                for(const e of d.items){
                    if((id===config.calendarId&&e.id===eventId(ignoreId))||e.status==='cancelled'||e.transparency==='transparent'||e.attendees?.some(a=>a.self&&a.responseStatus==='declined'))continue;
                    const point=value=>value?.dateTime?Date.parse(value.dateTime):localTimeToUtc(value?.date,'00:00',d.timeZone||config.timeZone);
                    const start=point(e.start),end=point(e.end);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)core.fail('Invalid calendar event.',503);
                    result.push({start,end});
                }
                pageToken=d.nextPageToken;
            }while(pageToken);
        }
        return result;
    }
    const configFor=r=>({calendarId:r.calendarId,blockCalendarIds:r.blockCalendarIds,timeZone:r.slot.timeZone});
    function validateEvent(r,e){
        const range=slotInterval(r.slot);
        if(!e||e.status==='cancelled'||e.transparency==='transparent'||e.extendedProperties?.private?.sponsorshipId!==r.id||Date.parse(e.start?.dateTime)!==range.start||Date.parse(e.end?.dateTime)!==range.end)
            core.fail('The reserved calendar event changed. Chris needs to review it before payment.',409);
    }
    async function verifyHold(r){
        const e=await request(path(r.calendarId)+'/'+eventId(r.id));validateEvent(r,e);
        const range=slotInterval(r.slot),ranges=await busy(configFor(r),range.start,range.end,r.id);
        if(ranges.some(b=>overlaps(range,b)))core.fail('The calendar has a new conflict. Chris needs to review this booking.',409);
    }
    async function hold(r){
        let e=await request(path(r.calendarId)+'/'+eventId(r.id));
        if(e){try{await verifyHold(r);}catch{core.fail('The existing reservation needs a calendar review.',503);}return;}
        const range=slotInterval(r.slot),ranges=await busy(configFor(r),range.start,range.end,r.id);
        if(ranges.some(b=>overlaps(range,b)))core.fail('The calendar now has a conflict.',409);
        try{
            e=await request(path(r.calendarId)+'?sendUpdates=none',{method:'POST',body:{id:eventId(r.id),summary:'Video shoot hold — '+r.business,
                description:`Filming: ${r.slot.start} to ${r.slot.end}\nCalendar block includes travel buffers. Awaiting agreement and payment.\n${SITE}/book/manage/?request=${r.id}`,
                location:r.location,visibility:'private',transparency:'opaque',start:{dateTime:new Date(range.start).toISOString(),timeZone:r.slot.timeZone},
                end:{dateTime:new Date(range.end).toISOString(),timeZone:r.slot.timeZone},extendedProperties:{private:{sponsorshipId:r.id}}}});
        }catch(error){if(error.code!==409)throw error;e=await request(path(r.calendarId)+'/'+eventId(r.id));}
        // A conflict discovered after insertion retains the local reservation for
        // manual review rather than releasing a still-existing calendar block.
        try{validateEvent(r,e);await verifyHold(r);}catch{core.fail('The reserved shoot needs a calendar review.',503);}
    }
    async function confirm(r){
        await verifyHold(r);
        await request(path(r.calendarId)+'/'+eventId(r.id)+'?sendUpdates=none',{method:'PATCH',body:{summary:'Video shoot — '+r.business,
            description:`Agreement signed. Payment received.\nFilming: ${r.slot.start} to ${r.slot.end}\nCalendar block includes travel buffers.\n${SITE}/book/manage/?request=${r.id}`}});
    }
    return {busy,hold,verifyHold,confirm};
}
function createPayments({secret,fetchImpl=fetch}){
    async function request(path,params,key){
        const r=await fetchImpl('https://api.stripe.com/v1/'+path,{method:params?'POST':'GET',headers:{Authorization:'Bearer '+secret(),'Stripe-Version':'2026-08-26.dahlia',
            ...(params?{'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':key}:{})},...(params?{body:new URLSearchParams(params)}:{}),signal:AbortSignal.timeout(15000)});
        const d=await r.json();if(!r.ok)core.fail('Stripe is temporarily unavailable. Please try again.',503);return d;
    }
    async function issue(r,save,now){
        const canCreate=()=>{if(now-r.billingStartedAt>23*3600000)core.fail('Invoice creation needs review before retrying. Please contact Chris.',409);};
        let customer=r.stripeCustomerId,invoice=r.invoice?.id?await request('invoices/'+r.invoice.id):null;
        if(!customer){canCreate();customer=(await request('customers',{email:r.email,name:r.business,'metadata[sponsorshipId]':r.id},r.id+'-customer')).id;await save({stripeCustomerId:customer});}
        if(!invoice){canCreate();invoice=await request('invoices',{customer,collection_method:'send_invoice',days_until_due:String(r.package.paymentDueDays),auto_advance:'false',
            pending_invoice_items_behavior:'exclude','automatic_tax[enabled]':'false',
            'metadata[sponsorshipId]':r.id,'metadata[agreementHash]':r.agreement.hash,
            description:r.package.title+' · Filming '+r.slot.start,footer:'Signed agreement reference: '+r.agreement.hash},r.id+'-invoice');
            await save({invoice:{id:invoice.id,number:invoice.number}});
        }
        const validateIdentity=()=>{
            if(invoice.customer!==customer||invoice.metadata?.sponsorshipId!==r.id||invoice.metadata?.agreementHash!==r.agreement.hash
                ||invoice.currency!=='usd'||invoice.collection_method!=='send_invoice'||invoice.automatic_tax?.enabled
                ||invoice.discounts?.length||invoice.default_tax_rates?.length)
                core.fail('Invoice details changed. Chris needs to review them before payment.',409);
        };
        validateIdentity();
        if(invoice.status==='draft'){
            // Check line metadata before adding: safe even after Stripe's 24h
            // idempotency window, and never bills unrelated pending invoice items.
            const lines=await request('invoices/'+invoice.id+'/lines?limit=100');
            if(lines.has_more||!Array.isArray(lines.data)||lines.data.length>1||lines.data.some(l=>
                l.metadata?.sponsorshipId!==r.id||l.amount!==r.package.amount||l.currency!=='usd'
                ||l.discount_amounts?.length||l.tax_amounts?.length||l.taxes?.length||l.proration))
                core.fail('Invoice lines changed. Chris needs to review them before payment.',409);
            if(!lines.data.length){
                canCreate();await request('invoiceitems',{customer,invoice:invoice.id,amount:String(r.package.amount),currency:'usd',
                    description:r.package.title+' — '+r.package.includes,'metadata[sponsorshipId]':r.id},r.id+'-line');
            }
            invoice=await request('invoices/'+invoice.id+'/finalize',{auto_advance:'false'},r.id+'-finalize');
        }
        validateIdentity();
        if(invoice.currency!=='usd'||invoice.total!==r.package.amount||!['open','paid'].includes(invoice.status))core.fail('Invoice total needs review. No payment link was released.',409);
        return invoice;
    }
    const recurring=require('./sponsorship-recurring').createRecurringPayments(request);
    return {issue:(r,save,now)=>r.package.billing&&r.package.billing!=='once'?recurring.issue(r,save,now):issue(r,save,now),retrieve:id=>request('invoices/'+encodeURIComponent(id)),
        retrieveSubscription:recurring.retrieveSubscription,cancelRenewal:recurring.cancelRenewal,verifyInitialPlan:recurring.verifyInitialPlan};
}
module.exports={createCalendar,createPayments};
