'use strict';
// Reviewable defaults only. Loading this draft never opens live booking.
const agreements=require('./sponsorship-agreements.json');
const common={currency:'usd',durationMinutes:180,paymentDueDays:7,
    channels:'Instagram @chrizcerney, Chris Cerney’s Facebook page, and TikTok',
    revisions:'No revisions, client review rounds, alternate edits, or reshoots included.',
    usageRights:'Chris publishes on his channels only. No website use, reposting, footage delivery, ads, or repurposing without a separate written agreement.',
    priceNote:'Filming usually takes 1–3 hours. Allow up to 3 hours for the initial session; scope is confirmed before approval. No audience or sales guarantees.'};
const monthlyTurnaround='Often within one week after filming. Monthly videos may be spaced through the month according to the agreed posting plan. Future filming dates are arranged with Chris.';
const packages=[
    {...common,id:'reporter-feature',title:'Reporter Feature',amount:60000,billing:'once',videoCount:1,exclusive:false,
        includes:'One promotional video filmed on location, approximately 1–2 minutes, edited and posted on Chris’s channels.',
        turnaround:'Often posted within one week after filming. A specific launch date must be agreed in writing.'},
    {...common,id:'monthly-partner',title:'Monthly Partner',amount:150000,billing:'monthly',videoCount:2,exclusive:false,
        includes:'Two promotional videos per month, approximately 1–2 minutes each, monthly story planning, and reserved filming time. Scope and sessions are confirmed with Chris. No category exclusivity.',turnaround:monthlyTurnaround},
    {...common,id:'monthly-campaign',title:'Monthly Campaign',amount:250000,billing:'monthly',videoCount:4,exclusive:false,
        includes:'Four promotional videos per month, approximately 1–2 minutes each, with monthly story planning and a posting plan built around your business, people, and offers. Filming sessions and scope are agreed with Chris. No category exclusivity.',turnaround:monthlyTurnaround},
    ...['monthly','three_month'].map(billing=>({...common,id:billing==='monthly'?'exclusive-monthly':'exclusive-three-month',title:'Exclusive Category Partner',amount:400000,billing,videoCount:2,exclusive:true,
        includes:'Two promotional videos per month, approximately 1–2 minutes each, monthly story planning, reserved filming time, and exclusivity in one approved business category and geographic market. Independent journalism remains separate.',turnaround:monthlyTurnaround}))
];
const text=item=>[item.title,item.introduction,...item.sections.flatMap(s=>[s.title,...s.paragraphs])].join('\n\n');
const draft={enabled:false,package:null,packages,
    terms:{version:agreements.version,provider:agreements.provider,text:text(agreements.general),exclusiveText:text(agreements.exclusive),approved:false},
    weeklyWindows:[2,3,4,5,6].map(day=>({day,start:'13:00',end:'18:00'})),windows:[],
    timeZone:'America/Los_Angeles',calendarId:'0ab2790d62002d3010a0b4423149bd380e8b66dbdcd755fce350e583f7feb163@group.calendar.google.com',
    blockCalendarIds:['chrisserknee@gmail.com','0ab2790d62002d3010a0b4423149bd380e8b66dbdcd755fce350e583f7feb163@group.calendar.google.com'],bufferBefore:30,bufferAfter:30,leadHours:24};
module.exports={draft,packages};
