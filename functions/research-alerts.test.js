'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAlerts}=require('./research-alerts');
const date=new Date().toISOString(),old=new Date(Date.now()-48*3600000).toISOString();
const story={id:'a'.repeat(64),notify:true,observedAt:date,createdAt:date};
const device={id:'device',sessionPolicy:'until-sign-out',expiresAt:null,subscribedAt:old,subscription:{endpoint:'https://example.invalid/push'}};
test('research notification retries stop at six attempts',async()=>{let calls=0;const alerts=createAlerts({read:async()=>({generation:1,data:{attempt:6,status:'pending'}}),write:async()=>{calls++;},send:async()=>{calls++;}});await alerts.deliver(story,device,{enabledAt:old});assert.equal(calls,0);});
test('older source findings never produce a new retry notification',async()=>{let calls=0;const alerts=createAlerts({read:async()=>{calls++;},write:async()=>{calls++;},send:async()=>{calls++;}});await alerts.deliver({...story,observedAt:old},device,{enabledAt:old});assert.equal(calls,0);});
