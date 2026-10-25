'use strict';
const {createHash,timingSafeEqual}=require('node:crypto');
const fail=(message,code=400)=>{throw Object.assign(new Error(message),{code});};
function field(value,label,max,required=true){
    if(typeof value!=='string'||value.trim().length>max||(required&&!value.trim()))fail(`Check ${label}.`);
    return value.trim();
}
const hash=value=>createHash('sha256').update(value).digest('hex');
function validToken(value,expected){
    if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)||!/^[a-f0-9]{64}$/.test(expected||''))return false;
    return timingSafeEqual(Buffer.from(hash(value),'hex'),Buffer.from(expected,'hex'));
}
function intake(b){
    const r={business:field(b.business,'business name',160),name:field(b.name,'contact name',120),email:field(b.email,'email',254).toLowerCase(),
        businessDescription:field(b.businessDescription,'business description',1500),brief:field(b.brief,'video idea',3000),location:field(b.location,'filming location',300),
        phone:field(b.phone||'','phone number',40,false),website:field(b.website||'','website',300,false)};
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email))fail('Enter a valid email.');
    if(b.requestAcknowledged!==true)fail('Confirm that this is a request, subject to approval.');
    return r;
}
function packageConfig(p){
    if(!p||!Number.isSafeInteger(p.amount)||p.amount<50||p.amount>10000000)fail('Enter a package price in USD cents.');
    if(!Number.isInteger(p.durationMinutes)||p.durationMinutes<30||p.durationMinutes>480)fail('Set filming duration between 30 and 480 minutes.');
    const paymentDueDays=p.paymentDueDays??7;
    if(!Number.isInteger(paymentDueDays)||paymentDueDays<1||paymentDueDays>30)fail('Set invoice payment terms between 1 and 30 days.');
    const billing=p.billing||'once';
    if(!['once','monthly','three_month'].includes(billing))fail('Choose a valid billing plan.');
    const id=p.id||'feature';if(!/^[a-z][a-z0-9-]{0,59}$/.test(id))fail('Use a valid package ID.');
    const videoCount=p.videoCount??1;if(!Number.isInteger(videoCount)||videoCount<1||videoCount>10)fail('Set the included video count.');
    const result={id,title:field(p.title,'package title',120),amount:p.amount,currency:'usd',durationMinutes:p.durationMinutes,
        billing,videoCount,exclusive:p.exclusive===true,
        paymentDueDays,
        includes:field(p.includes,'package inclusions',3000),channels:field(p.channels,'posting channels',500),turnaround:field(p.turnaround,'turnaround',500),
        revisions:field(p.revisions,'revisions',500),priceNote:field(p.priceNote||'','price details',500,false),
        usageRights:field(p.usageRights||'Published on Chris’s channels only. No website use, reposting, footage delivery, or repurposing without a separate written agreement.','content rights',1000)};
    result.billingDescription=billingDescription(result);return result;
}
function billingDescription(p){
    const amount=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(p.amount/100);
    if(p.billing==='monthly')return `${amount} per month. Automatically renews each month until canceled before the next billing period. Cancellation takes effect at the end of the paid period.`;
    if(p.billing==='three_month')return `Three monthly payments of ${amount} (${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(3*p.amount/100)} total). Three-month commitment. Ends after month three, with no automatic fourth payment.`;
    return `${amount} once. No recurring charges.`;
}
function agreement(order,terms,now){
    const document={version:terms.version,provider:terms.provider,customer:order.business,contact:order.name,email:order.email,
        package:order.package,filming:order.slot,location:order.location,videoBrief:order.brief,terms:terms.text,issuedAt:now,
        ...(order.exclusivity?{exclusivity:order.exclusivity,exclusivityTerms:terms.exclusiveText}:{}),
        billingDescription:billingDescription(order.package)};
    return {document,hash:hash(JSON.stringify(document))};
}
function signatureDrawing(value){
    if(!value||value.version!==1||!Array.isArray(value.strokes)||!value.strokes.length||value.strokes.length>80)fail('Draw your signature before continuing.');
    let count=0,length=0,minX=1,minY=1,maxX=0,maxY=0;
    const strokes=value.strokes.map(stroke=>{
        if(!Array.isArray(stroke)||!stroke.length)fail('Invalid signature drawing.');
        let previous;
        return stroke.map(point=>{
            if(++count>1200||!Array.isArray(point)||point.length!==2||point.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1))fail('Invalid signature drawing.');
            const p=point.map(n=>Math.round(n*10000)/10000);
            minX=Math.min(minX,p[0]);maxX=Math.max(maxX,p[0]);minY=Math.min(minY,p[1]);maxY=Math.max(maxY,p[1]);
            if(previous)length+=Math.hypot(p[0]-previous[0],p[1]-previous[1]);previous=p;return p;
        });
    });
    if(count<4||length<0.06||maxX-minX<0.03||maxY-minY<0.01)fail('Draw your full signature, then try again.');
    return {version:1,strokes};
}
function sign(order,b,now){
    if(!['approved','signed'].includes(order.status))fail('This request is not ready for signing.',409);
    if(b.agreementHash!==order.agreement.hash)fail('The agreement changed. Reload it before signing.',409);
    if(b.electronicConsent!==true||b.authorized!==true)fail('Confirm consent to sign electronically and authority to sign for the business.');
    if(order.package.billing!=='once'&&order.package.billing&&b.recurringConsent!==true)fail('Confirm the amount, recurring billing, commitment, and cancellation terms.');
    const name=field(b.signerName,'signature name',120),title=field(b.signerTitle,'role at the business',120);
    const drawing=signatureDrawing(b.signatureDrawing),drawingHash=hash(JSON.stringify(drawing));
    if(order.signature){if(order.signature.name!==name||order.signature.title!==title||order.signature.drawingHash!==drawingHash)fail('This agreement has already been signed.',409);return order;}
    return {...order,status:'signed',signature:{name,title,signedAt:now,agreementHash:order.agreement.hash,
        drawing,drawingHash,electronicConsent:true,authorized:true,recurringConsent:b.recurringConsent===true,billingDescription:billingDescription(order.package),clientKey:b.clientKey,userAgent:String(b.userAgent||'').slice(0,500)}};
}
function paidRecord(order,invoice,now){
    if(order.package.billing&&order.package.billing!=='once'){
        const {invoiceIdentity,monthBoundary}=require('./sponsorship-recurring'),identity=invoiceIdentity(invoice),payments=order.payments||[];
        const period=invoice.lines?.data?.[0]?.period;
        if(!order.signature?.recurringConsent||!['signed','paid'].includes(order.status)||identity.subscriptionId!==order.stripeSubscriptionId||identity.metadata.sponsorshipId!==order.id||identity.metadata.agreementHash!==order.agreement.hash||invoice.customer!==order.stripeCustomerId||invoice.status!=='paid'||invoice.currency!=='usd'||invoice.total!==order.package.amount||invoice.amount_paid!==order.package.amount||!Number.isSafeInteger(period?.start)||!Number.isSafeInteger(period?.end)||period.end<=period.start)fail('Payment does not match the signed subscription.',409);
        if(payments.some(p=>p.id===invoice.id))return order;
        if(!payments.length&&invoice.id!==order.invoice?.id)fail('The initial subscription invoice must be paid first.',409);
        if(payments.some(p=>p.periodStart===period.start*1000))fail('This service month already has a payment.',409);
        if(order.package.billing==='three_month'&&(payments.length>=3||period.start*1000>=order.billing?.endsAt))fail('Payment falls outside the three-month commitment.',409);
        const anchor=order.billing?.startedAt/1000,first=new Date(anchor*1000),current=new Date(period.start*1000);
        const month=(current.getUTCFullYear()-first.getUTCFullYear())*12+current.getUTCMonth()-first.getUTCMonth();
        if(!Number.isSafeInteger(anchor)||!Number.isSafeInteger(month)||month<0||period.start!==monthBoundary(anchor,month)||period.end!==monthBoundary(anchor,month+1)
            ||invoice.lines?.has_more||invoice.lines?.data?.length!==1
            ||(order.package.billing==='three_month'&&(month>2||period.end*1000>order.billing.endsAt)))fail('Payment service dates do not match the signed subscription.',409);
        // Webhook delivery order is not guaranteed. Recording an older paid
        // invoice must not move the displayed current service month backwards.
        const latestPeriod=period.end*1000>=(order.billing?.periodEnd||0);
        return {...order,status:'paid',paidAt:order.paidAt||now,calendarConfirmed:order.calendarConfirmed||false,
            payments:[...payments,{id:invoice.id,number:invoice.number,amount:invoice.amount_paid,periodStart:period.start*1000,periodEnd:period.end*1000,paidAt:now}],
            billing:latestPeriod?{...order.billing,status:['canceled','incomplete_expired'].includes(order.billing?.status)?order.billing.status:'active',lastInvoiceId:invoice.id,periodStart:period.start*1000,periodEnd:period.end*1000}:order.billing};
    }
    if(!order.signature||!['signed','paid'].includes(order.status)||invoice.id!==order.invoice?.id||invoice.metadata?.sponsorshipId!==order.id
        ||(order.stripeCustomerId&&invoice.customer!==order.stripeCustomerId)
        ||invoice.metadata?.agreementHash!==order.agreement.hash||invoice.status!=='paid'||invoice.amount_paid!==order.package.amount
        ||invoice.total!==order.package.amount||invoice.currency!=='usd')fail('Payment does not match the signed invoice.',409);
    if(order.status==='paid')return order;
    return {...order,status:'paid',paidAt:now,calendarConfirmed:false};
}
function publicRecord(r){
    return {id:r.id,status:r.status,business:r.business,package:r.package,slot:r.slot,location:r.location,brief:r.brief,declineReason:r.declineReason,exclusivity:r.exclusivity,
        agreement:r.agreement,signature:r.signature?{name:r.signature.name,title:r.signature.title,signedAt:r.signature.signedAt,agreementHash:r.signature.agreementHash,drawing:r.signature.drawing,drawingHash:r.signature.drawingHash}:null,
        invoice:r.invoice?{number:r.invoice.number}:null,billing:r.billing,payments:r.payments?.map(({id,...p})=>p),calendarConfirmed:r.calendarConfirmed,createdAt:r.createdAt};
}
module.exports={fail,field,hash,validToken,intake,packageConfig,billingDescription,agreement,signatureDrawing,sign,paidRecord,publicRecord};
