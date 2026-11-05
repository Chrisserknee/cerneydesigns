import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {availability,safeURL,feedbackURL} from '../community-help/policy.mjs';
const cards=JSON.parse(fs.readFileSync(new URL('../community-help/catalog.json',import.meta.url)));
test('catalog contains sourced, review-dated resources with concise artwork copy',()=>{
  assert.ok(cards.length >= 28);
  assert.equal(new Set(cards.map(c=>c.id)).size,cards.length);
  for(const card of cards){
    assert.equal(availability(card,Date.parse(card.checkedAt)),'Source checked',card.id);
    assert.ok(card.evidence,card.id);
    assert.ok(safeURL(card.sourceURL),card.id);
    assert.ok(card.title.length <= 40,card.id+' headline');
    assert.ok(card.message.length <= 70,card.id+' action line');
    assert.ok(card.details.length > card.message.length,card.id+' practical details');
  }
});
test('deadline expires exactly at the boundary and reopening does not reset it',()=>{const c=cards.find(c=>c.endsAt);assert.equal(availability(c,Date.parse(c.endsAt)),'Ended');assert.equal(availability(c,Date.parse(c.endsAt)+86400000),'Ended');});
test('future reviews, missing reviews and closed cards never look current',()=>{const c=cards[0],now=Date.parse(c.checkedAt);assert.equal(availability(c,now-1),'Needs review');assert.equal(availability({...c,reviewBy:null},now),'Needs review');assert.equal(availability({...c,state:'resolved'},now),'Closed');assert.equal(availability(c,Date.parse(c.reviewBy)),'Recheck needed');});
test('feedback and source links reject script URLs and untrusted query fragments',()=>{assert.equal(safeURL('javascript:alert(1)'),null);assert.equal(safeURL('https://a:b@example.com'),null);assert.throws(()=>feedbackURL('../bad','helped'));assert.throws(()=>feedbackURL('211','delete'));assert.equal(feedbackURL('211','correction'),'/submit-story/?community=211&feedback=correction');});

test('changed wording cannot reuse an earlier source review',()=>{const c=cards[0];assert.equal(availability({...c,message:'A new unsupported claim'},Date.parse(c.checkedAt)),'Needs review');});
