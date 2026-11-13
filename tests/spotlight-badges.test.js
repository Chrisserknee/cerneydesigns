'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { membershipBadge } = require('../api/_lib/spotlight-badges');
test('only the configured live paid plan earns the construction badge, never self-entered metadata', () => {
    const before = process.env.SPOTLIGHT_CUSTOM_PLANS_JSON;
    try {
        process.env.SPOTLIGHT_CUSTOM_PLANS_JSON = JSON.stringify([{key:'hare-250-v1',subscription:'sub_hare',customer:'cus_hare',price:'price_hare',invoice:'in_hare',amount:25000}]);
        const sub = {id:'sub_hare',customer:'cus_hare',livemode:true,items:{data:[{price:{id:'price_hare'}}]}};
        assert.equal(membershipBadge(sub,{live:true,priceId:'price_base'}),'exclusive-construction');
        for (const copy of [{...sub,id:'sub_other'},{...sub,customer:'cus_other'},{...sub,livemode:false},{...sub,items:{data:[{price:{id:'price_base',unit_amount:100000}}]},metadata:{membershipBadge:'exclusive-construction'}}]) assert.equal(membershipBadge(copy,{live:true,priceId:'price_base'}),'');
        assert.equal(membershipBadge(sub,{live:false,priceId:'price_base'}),'');
        process.env.SPOTLIGHT_CUSTOM_PLANS_JSON='[]';
        assert.equal(membershipBadge(sub,{live:true,priceId:'price_base'}),'');
    } finally { if(before===undefined) delete process.env.SPOTLIGHT_CUSTOM_PLANS_JSON; else process.env.SPOTLIGHT_CUSTOM_PLANS_JSON=before; }
});
