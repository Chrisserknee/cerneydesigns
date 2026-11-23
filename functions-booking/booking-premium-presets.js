'use strict';
// Explicitly paused: loading this draft never publishes availability or approves terms.
const {draft:legacy}=require('./sponsorship-presets');
const videoStyles=[
    {id:'business-showcase',title:'Business showcase',description:'Chris introduces your business, meets your team, and highlights what you do.'},
    {id:'chris-tries-it',title:'Chris tries it',description:'A fun, hands-on video: Chris bakes a cake, makes a bagel, or tries your equipment. Tell us what you have in mind.'}
];
const common={currency:'usd',billing:'once',videoCount:1,exclusive:false,paymentDueDays:7,maxVideoSeconds:179,
    channels:'One finished video on Chris’s channels, with a collaboration invite on request where supported.',
    turnaround:'Delivery and posting dates are confirmed with Chris before approval.',
    revisions:'Revision allowances are confirmed in the approved scope before signing.',
    usageRights:'Published through Chris’s accounts. Separate uploads, copies, and reuse require written permission.'};
const packages=[
    {...common,id:'promotional-video',title:'Promotional video',amount:100000,priceType:'from',durationMinutes:120,videoStyles,videoLengthNote:'Usually a shorter, focused video. Finished video: up to 2 minutes 59 seconds.',
        includes:'Choose a business showcase or a fun, hands-on video with Chris Cerney. Includes one finished video and up to two hours of filming. Chris confirms the concept and final price before you sign.',
        priceNote:'Starts at $1,000. Chris confirms the final price and scope when approving your request. No payment is taken when you request a date.'},
    {...common,id:'event-coverage',title:'Event coverage',amount:175000,priceType:'fixed',durationMinutes:180,videoLengthNote:'Usually a longer recap than a promotional video. Finished video: up to 2 minutes 59 seconds.',
        includes:'Capture the atmosphere, people, and highlights of your event with Chris Cerney. Includes one finished recap video and up to three hours of filming on location. Chris confirms the coverage plan before you sign.',
        priceNote:'$1,750 for up to three hours of event coverage. Longer events or additional work need a separate agreement.'}
];
const premiumTerms = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'booking-premium-terms.txt'), 'utf8'
).trim();
const draft={...structuredClone(legacy),enabled:false,package:null,packages,
    terms:{...legacy.terms,text:premiumTerms,exclusiveText:'',version:'video-event-2026-11-23-v4',approved:false},
    availabilityMode:'dates',bookingHorizonDays:180,weeklyWindows:[],windows:[]};
module.exports={draft,packages};
