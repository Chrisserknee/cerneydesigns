'use strict';
// Explicitly paused: loading this draft never publishes availability or approves terms.
const {draft:legacy}=require('./sponsorship-presets');
const common={currency:'usd',billing:'once',videoCount:1,exclusive:false,paymentDueDays:7,
    channels:'Posting channels and any delivered files are confirmed in the approved scope.',
    turnaround:'Delivery and posting dates are confirmed with Chris before approval.',
    revisions:'Revision allowances are confirmed in the approved scope before signing.',
    usageRights:'Content usage, delivery, and any advertising rights are confirmed in the agreement. No audience or sales guarantees.'};
const packages=[
    {...common,id:'promotional-video',title:'Promotional video',amount:100000,priceType:'from',durationMinutes:120,
        includes:'On-location promotional filming with Chris Cerney for your business. Up to two hours of filming; final deliverables and price are agreed before you sign.',
        priceNote:'Starts at $1,000. Chris confirms the final price and scope when approving your request. No payment is taken when you request a date.'},
    {...common,id:'event-coverage',title:'Event coverage',amount:175000,priceType:'fixed',durationMinutes:180,
        includes:'Event coverage with Chris Cerney, with up to three hours on location. The coverage plan and final deliverables are confirmed before you sign.',
        priceNote:'$1,750 for up to three hours of event coverage. Longer events or additional work need a separate agreement.'}
];
// Carry forward the prior reviewed agreement, removing obsolete prices, hours,
// and recurring plans. The adapted text remains unapproved until Chris reviews it.
const agreement=structuredClone(require('./sponsorship-agreements.json').general);
agreement.title='Video and Event Coverage Agreement';
agreement.sections[0].paragraphs[0]='Chris will provide the promotional video or event coverage described in the accepted booking summary. Promotional filming allows up to two hours on location; event coverage allows up to three hours. The accepted summary confirms the final price, deliverables, posting channels, delivery dates, and any agreed usage rights before the Client signs.';
agreement.sections[0].paragraphs[2]=agreement.sections[0].paragraphs[2].replace('Shoots generally take one to three hours depending on the package and scope.','The duration is the one stated in the accepted booking summary.');
agreement.sections[1].title='2. Price and payment';
agreement.sections[1].paragraphs=[agreement.sections[1].paragraphs[0], 'The promotional video starting price is $1,000; the final approved scope and price appear in the agreement before signing. Event coverage is $1,750 for up to three hours. These are one-time bookings with no automatic monthly renewal.', agreement.sections[1].paragraphs[3].replace('For a $600 one-video booking, that refund is $600.','Any refund for undelivered services is based on the amount actually paid.').split(' For a partly completed monthly package')[0]];
agreement.sections[2].paragraphs[0]=agreement.sections[2].paragraphs[0].split(' Current usual filming hours')[0]+' Only dates and times Chris opens on the booking page may be requested, subject to calendar availability.';
agreement.sections[2].paragraphs[1]='Filming, delivery, and any posting dates are confirmed in the approved scope before signing. An exact launch date must be agreed in writing.';
agreement.sections[2].paragraphs[2]=agreement.sections[2].paragraphs[2].split(' Unused monthly deliverables')[0];
agreement.sections[3].paragraphs[0]=agreement.sections[3].paragraphs[0].replace('No Client review round, revisions, alternate edits, or reshoots are included.','Unless expressly included in the accepted scope, no Client review round, revisions, alternate edits, or reshoots are included.');
agreement.sections[10].paragraphs[0]='This one-time agreement covers the accepted booking. Cancellation or rescheduling requests must be made directly to cerneymedia@gmail.com. Changing a calendar entry alone does not cancel the booking.';
const premiumTerms=[agreement.title,agreement.introduction,...agreement.sections.flatMap(s=>[s.title,...s.paragraphs])].join('\n\n');
const draft={...structuredClone(legacy),enabled:false,package:null,packages,
    terms:{...legacy.terms,text:premiumTerms,exclusiveText:'',version:legacy.terms.version+'-premium-review',approved:false},
    availabilityMode:'dates',bookingHorizonDays:180,weeklyWindows:[],windows:[]};
module.exports={draft,packages};
