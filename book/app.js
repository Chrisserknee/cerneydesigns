'use strict';
(()=>{
const $=id=>document.getElementById(id),form=$('requestForm');
const dateInput=form.elements.namedItem('date'),timeInput=form.elements.namedItem('slotStart');let offer,selected,order,access,busy=false,availabilityVersion=0;let strokes=[],stroke;
const text=(tag,value,className)=>{const e=document.createElement(tag);e.textContent=value;if(className)e.className=className;return e;};
const money=c=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(c/100);
const when=(value,zone)=>new Intl.DateTimeFormat('en-US',{dateStyle:'full',timeStyle:'short',timeZone:zone||'America/Los_Angeles'}).format(new Date(value));
function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);}
async function api(body){const r=await fetch('/api/booking',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const d=await r.json();if(!r.ok){if(d.code==='BOOKING_LOGIN_REQUIRED')location.reload();throw Error(d.error||'Please try again.');}return d;}
async function action(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){notice(e.message,true);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=b.dataset.unavailable==='true');}}
function saveAccess(a){access=a;sessionStorage.setItem('cs_booking_request',JSON.stringify(a));}
try{const h=new URLSearchParams(location.hash.slice(1));if(/^[a-f0-9]{32}$/.test(h.get('id'))&&/^[a-f0-9]{64}$/.test(h.get('token'))){saveAccess({id:h.get('id'),token:h.get('token')});history.replaceState(null,'',location.pathname);}else access=JSON.parse(sessionStorage.getItem('cs_booking_request')||'null');}catch{access=null;}
const packageDescriptions = {
    'promotional-video': 'Introduce your business with a showcase or a hands-on video with Chris.',
    'event-coverage': 'Capture the people and highlights of your event in one edited recap.'
};
async function loadPackages() {
    offer = await api({op: 'offer'});
    const packages = $('packages');
    packages.replaceChildren();
    for (const service of offer.packages) {
        const description = packageDescriptions[service.id];
        const card = text('article', '', 'card booking-card');

        const content = text('div', '', 'service-content');
        const heading = text('div', '', 'service-heading');
        const price = text('p', '', 'service-price');
        if (service.priceType === 'from') price.append(text('small', 'From '));
        price.append(document.createTextNode(money(service.amount)));
        if (service.billing !== 'once') price.append(text('small', ' / month'));
        heading.append(text('h2', service.title + (service.billing === 'three_month' ? ' · 3 months' : '')), price);
        const filmingHours = service.durationMinutes / 60;
        const filming = Number.isInteger(filmingHours)
            ? 'Up to ' + filmingHours + (filmingHours === 1 ? ' hour' : ' hours') + ' filming'
            : 'Up to ' + service.durationMinutes + ' min filming';
        const videos = service.videoCount || 1;
        const deliverables = text('p', (videos === 1 ? '1 finished video' : videos + ' finished videos') + ' · ' + filming, 'service-facts');
        const button = text('button', offer.open ? 'Choose package →' : 'Requests paused');
        button.disabled = !offer.open;
        button.dataset.unavailable = String(!offer.open);
        button.addEventListener('click', () => choose(service));
        content.append(heading, text('p', description || service.includes, 'service-description'), deliverables);
        if (!description) {
            const details = document.createElement('details');
            details.append(text('summary', 'Package details'), text('p', service.billingDescription),
                text('p', service.channels), text('p', service.turnaround), text('p', service.usageRights));
            content.append(details);
        }
        content.append(button);
        card.append(content);
        packages.append(card);
    }
}
$('backToServices').onclick = () => {
    availabilityVersion++;
    $('requestPanel').hidden = true;
    $('intro').hidden = false;
    $('packages').hidden = false;
    notice('');
    $('bookingTitle').focus();
};
const calendarMonthFormat = new Intl.DateTimeFormat('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC'
});
const calendarDateFormat = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full', timeZone: 'UTC'
});
const startTimeFormat = new Intl.DateTimeFormat('en-US', {
    timeStyle: 'short', timeZone: 'America/Los_Angeles'
});
const monthKey = value => value.slice(0, 7);
const calendarDate = value => new Date(value + 'T12:00:00Z');
const monthAfter = (month, offset) => {
    const date = calendarDate(month + '-01');
    date.setUTCMonth(date.getUTCMonth() + offset);
    return monthKey(date.toISOString());
};
let offeredDays = new Set(), displayedMonth = '', firstMonth = '', lastMonth = '';

function setUnavailable(button, unavailable) {
    button.disabled = unavailable || busy;
    button.dataset.unavailable = String(unavailable);
}

function showMonth(month) {
    if (month < firstMonth || month > lastMonth) return;
    displayedMonth = month;
    const firstDay = calendarDate(month + '-01');
    $('calendarMonth').textContent = calendarMonthFormat.format(firstDay);
    setUnavailable($('previousMonth'), month === firstMonth);
    setUnavailable($('nextMonth'), month === lastMonth);
    const days = $('calendarDays');
    days.replaceChildren();
    for (let blank = 0; blank < firstDay.getUTCDay(); blank++) {
        const placeholder = document.createElement('span');
        placeholder.setAttribute('aria-hidden', 'true');
        days.append(placeholder);
    }
    let availableThisMonth = false;
    for (const day = new Date(firstDay); monthKey(day.toISOString()) === month; day.setUTCDate(day.getUTCDate() + 1)) {
        const iso = day.toISOString().slice(0, 10);
        const available = offeredDays.has(iso);
        availableThisMonth ||= available;
        const button = text('button', day.getUTCDate(), 'secondary calendar-day');
        button.type = 'button';
        button.setAttribute('aria-label', calendarDateFormat.format(day) + (available ? '' : ', unavailable'));
        button.setAttribute('aria-pressed', String(dateInput.value === iso));
        setUnavailable(button, !available);
        if (available) button.addEventListener('click', () => chooseDate(iso, button));
        days.append(button);
    }
    $('calendarEmpty').hidden = availableThisMonth;
    $('calendarLegend').hidden = !availableThisMonth;
}

$('previousMonth').onclick = () => showMonth(monthAfter(displayedMonth, -1));
$('nextMonth').onclick = () => showMonth(monthAfter(displayedMonth, 1));

async function chooseDate(date, button) {
    const sequence = ++availabilityVersion;
    dateInput.value = date;
    const active = $('calendarDays').querySelector('[aria-pressed="true"]');
    if (active) active.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
    $('selectedDate').textContent = calendarDateFormat.format(calendarDate(date));
    timeInput.replaceChildren(new Option('Checking availability…', ''));
    $('availability').textContent = '';
    try {
        const {slots} = await api({op:'availability', date, packageId:selected.id});
        if (sequence !== availabilityVersion) return;
        timeInput.replaceChildren(new Option(slots.length ? 'Choose a time' : 'No times available', ''));
        for (const slot of slots) {
            timeInput.add(new Option(startTimeFormat.format(new Date(slot.start)), slot.start));
        }
        $('availability').textContent = slots.length ? '' : 'Choose another day to see more times.';
    } catch (error) {
        if (sequence !== availabilityVersion) return;
        timeInput.replaceChildren(new Option('Choose a date again', ''));
        $('availability').textContent = error.message;
    }
}

function choose(service) {
    availabilityVersion++;
    selected = service;
    const styles = service.videoStyles || [];
    $('videoStyleOptions').replaceChildren();
    $('videoStyles').hidden = !styles.length;
    for (const style of styles) {
        const label = text('label', '', 'video-style');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'videoStyleId';
        input.value = style.id;
        input.required = true;
        const copy = text('span', '');
        copy.append(text('strong', style.title), text('span', style.description));
        label.append(input, copy);
        $('videoStyleOptions').append(label);
    }
    const dates = offer.datesByPackage?.[service.id] || offer.dates;
    offeredDays = new Set(dates);
    const fallbackMonth = monthKey(new Date().toISOString());
    firstMonth = dates.length ? monthKey(dates[0]) : fallbackMonth;
    lastMonth = dates.length ? monthKey(dates.at(-1)) : fallbackMonth;
    dateInput.value = '';
    timeInput.replaceChildren(new Option('Choose a date first', ''));
    $('selectedDate').textContent = 'Choose a filming date';
    $('availability').textContent = '';
    showMonth(firstMonth);
    notice('');
    $('intro').hidden = true;
    $('packages').hidden = true;
    $('requestPanel').hidden = false;
    $('selectedTitle').textContent = service.title;
    $('selectedTerms').textContent = service.billingDescription;
    $('selectedTitle').focus({preventScroll:true});
    window.scrollTo(0, 0);
}
form.addEventListener('submit',e=>{e.preventDefault();action(async()=>{const payload=Object.fromEntries(new FormData(form));let pending;try{pending=JSON.parse(sessionStorage.getItem('cs_booking_pending'));}catch{}const fingerprint=JSON.stringify(payload);if(!pending||pending.fingerprint!==fingerprint){pending={fingerprint,token:Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('')};sessionStorage.setItem('cs_booking_pending',JSON.stringify(pending));}const r=await api({...payload,op:'submit',packageId:selected.id,offerRevision:offer.revision,token:pending.token,requestAcknowledged:form.requestAcknowledged.checked});saveAccess({id:r.id,token:pending.token});sessionStorage.removeItem('cs_booking_pending');await loadOrder();notice('Request saved. No payment has been taken.');});});
function agreementText(){const d=order.agreement.document;return [d.provider,d.customer,order.package.title,order.package.billingDescription,order.package.includes,order.videoStyle?'Video style: '+order.videoStyle.title+' — '+order.videoStyle.description:'',order.package.videoLengthNote||'','Posting channels: '+order.package.channels,'Turnaround: '+order.package.turnaround,'Revisions: '+order.package.revisions,'Content usage: '+order.package.usageRights,order.package.priceNote,order.paymentDueAt?'Payment deadline: '+when(order.paymentDueAt,order.slot.timeZone):'','Agreement version: '+d.version,'Filming: '+when(order.slot.start,order.slot.timeZone),'Location: '+order.location,'Video idea: '+order.brief,d.terms,d.exclusivityTerms||'',order.exclusivity?'Category: '+order.exclusivity.category+' · Market: '+order.exclusivity.market+' · Exceptions: '+order.exclusivity.exceptions:'',order.signature?'Signed by '+order.signature.name+' · '+order.signature.title+' · '+when(order.signature.signedAt,order.slot.timeZone):'','Agreement reference: '+order.agreement.hash].join('\n\n');}
async function loadOrder(){order=await api({op:'status',...access});$('packages').hidden=true;$('requestPanel').hidden=true;$('intro').hidden=true;$('orderPanel').hidden=false;$('status').textContent={pending:'Awaiting Chris’s review',accepting:'Approval processing',expired:'Booking expired',approved:'Ready to sign',signed:'Ready for payment',paid:'Payment received',declined:'Request declined'}[order.status]||order.status;$('orderTitle').textContent=order.business+' · '+order.package.title;$('orderDetails').textContent=when(order.slot.start,order.slot.timeZone)+' · '+order.location+' · '+order.package.billingDescription+(order.videoStyle?' · '+order.videoStyle.title:'')+(order.paymentDueAt?' · Pay by '+when(order.paymentDueAt,order.slot.timeZone):'');$('orderMessage').textContent=order.status==='paid'?(order.latePayment?'Payment received. Chris will review the deadline and contact you.':order.calendarConfirmed?'Your filming appointment is confirmed. Chris will coordinate the details with you.':'Payment received. Chris is checking the calendar confirmation; do not pay again.'):order.status==='pending'?'Chris will review your idea and filming time. No agreement has been signed and no payment has been taken.':order.status==='declined'?(order.declineReason||'Chris cannot accept this request. No payment has been taken.'):'Review the agreed scope below before continuing.';const link=location.origin+'/book/#'+new URLSearchParams(access);$('privateLink').href=link;$('privateLink').textContent=link;$('agreementPanel').hidden=!order.agreement;if(order.agreement)$('agreement').textContent=agreementText();const deadlinePassed = order.paymentDueAt && Date.now() >= order.paymentDueAt;
if (order.status === 'expired') $('orderMessage').textContent = 'The payment deadline passed and the filming time was released. Submit a new request to choose another time.';
if (deadlinePassed && ['approved','signed'].includes(order.status)) {
    $('orderMessage').textContent = 'The payment deadline has passed. Contact Chris about availability.';
}
$('signForm').hidden=order.status!=='approved'||deadlinePassed;configureAgreementForm();$('signedDetails').hidden=!order.signature;if(order.signature)$('signedDetails').textContent='Signed by '+order.signature.name+' on '+when(order.signature.signedAt,order.slot.timeZone);$('recurringConsent').hidden=order.package.billing==='once';$('signForm').recurringConsent.required=order.package.billing!=='once';$('recurringTerms').textContent='I agree to: '+order.package.billingDescription;$('pay').hidden=order.status!=='signed'||deadlinePassed;$('cancelRenewal').hidden=!(order.status==='paid'&&order.package.billing==='monthly'&&!order.billing?.cancelAtPeriodEnd&&order.billing?.status!=='canceled');$('billingInvoice').hidden=!(order.status==='paid'&&order.package.billing!=='once');}
const canvas=$('signature'),ctx=canvas.getContext('2d');ctx.lineWidth=3;ctx.lineCap='round';ctx.strokeStyle='#15232e';function point(e){const r=canvas.getBoundingClientRect();return [Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))];}canvas.addEventListener('pointerdown',e=>{if(strokes.length>=80)return;canvas.setPointerCapture(e.pointerId);stroke=[point(e)];strokes.push(stroke);});canvas.addEventListener('pointermove',e=>{if(!stroke||strokes.flat().length>=1200)return;const a=stroke.at(-1),b=point(e);stroke.push(b);ctx.beginPath();ctx.moveTo(a[0]*canvas.width,a[1]*canvas.height);ctx.lineTo(b[0]*canvas.width,b[1]*canvas.height);ctx.stroke();});for(const event of ['pointerup','pointercancel'])canvas.addEventListener(event,()=>{stroke=null;});$('clearSignature').onclick=()=>{strokes=[];ctx.clearRect(0,0,canvas.width,canvas.height);};
function configureAgreementForm() {
    const typed = order.typedAcceptance;
    $('drawSignature').hidden = typed;
    $('signingAuthority').hidden = typed;
    $('signForm').authorized.required = !typed;
    $('signAgreement').textContent = typed ? 'Accept agreement and continue to payment' : 'Sign agreement';
    $('agreementConsent').textContent = typed
        ? 'I have read and accept this agreement, agree to sign electronically using my typed name, and confirm I am authorized to accept for the client.'
        : 'I have read the agreement and consent to sign it electronically.';
}
$('signForm').onsubmit = e => {
    e.preventDefault();
    action(async () => {
        const form = e.target, typed = order.typedAcceptance;
        const acceptance = {
            op: 'sign', ...access, agreementHash: order.agreement.hash,
            signerName: form.signerName.value, signerTitle: form.signerTitle.value,
            electronicConsent: form.electronicConsent.checked,
            authorized: typed ? form.electronicConsent.checked : form.authorized.checked,
            recurringConsent: form.recurringConsent.checked,
            ...(typed ? {acceptanceMethod: 'typed'} : {signatureDrawing: {version: 1, strokes}})
        };
        try {
            const result = await api(acceptance);
            if (result.payment) return openPayment(result.payment);
        } catch (error) {
            // Acceptance can be saved before Stripe returns an invoice. Reload
            // the status so the customer can retry payment using the same record.
            await loadOrder().catch(() => {});
            throw error;
        }
        await loadOrder();
        notice('Agreement signed. You can now continue to Stripe to pay.');
    });
};
async function openPayment(result) {
    if (result.paid) {
        await loadOrder();
        notice('Payment received.');
        return;
    }
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || url.hostname !== 'invoice.stripe.com') throw Error('Payment link could not be verified. Contact Chris.');
    location.assign(url.href);
}
async function payment(op) { return openPayment(await api({op, ...access})); }
$('pay').onclick=()=>action(()=>payment('checkout'));$('billingInvoice').onclick=()=>action(()=>payment('billing-invoice'));$('refresh').onclick=()=>action(loadOrder);$('cancelRenewal').onclick=()=>{if(confirm('Cancel future monthly renewals? Your current paid service period continues.'))action(async()=>{await api({op:'cancel-renewal',...access,confirm:true});await loadOrder();notice('Future monthly renewals canceled.');});};$('downloadAgreement').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([agreementText()],{type:'text/plain'}));a.download='Cerney-Selects-agreement.txt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};$('newRequest').onclick=()=>{sessionStorage.removeItem('cs_booking_request');location.assign('/book/');};action(()=>access?loadOrder():loadPackages());
})();
