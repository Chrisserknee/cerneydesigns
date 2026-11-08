import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {availability,safeURL,feedbackURL,fingerprint} from '../community-help/policy.mjs';
const cards=JSON.parse(fs.readFileSync(new URL('../community-help/catalog.json',import.meta.url)));
const audit=JSON.parse(fs.readFileSync(new URL('../community-help/reviews.json',import.meta.url)));
test('catalog contains sourced, review-dated resources with concise artwork copy',()=>{
  assert.ok(cards.length >= 28);
  assert.equal(new Set(cards.map(c=>c.id)).size,cards.length);
  for(const card of cards){
    assert.equal(availability(card,Date.parse(card.checkedAt)),card.state==='reviewed'?'Source checked':'Needs review',card.id);
    assert.ok(card.evidence,card.id);
    assert.ok(safeURL(card.sourceURL),card.id);
    assert.ok(card.title.length <= 40,card.id+' headline');
    assert.ok(card.message.length <= 110,card.id+' action line');
    assert.ok(card.details.length > card.message.length,card.id+' practical details');
  }
});
test('published cards are bound to a documented review of their exact claims and access route',()=>{
  assert.equal(new Set(audit.reviews.map(r=>r.id)).size,audit.reviews.length);
  for(const card of cards){
    const review=audit.reviews.find(r=>r.id===card.id);
    assert.ok(review,card.id+' must be researched before publication');
    assert.equal(review.fingerprint,fingerprint(card),card.id+' changed since research');
    assert.equal(review.checkedAt,card.checkedAt);
    assert.equal(review.disposition,card.state);
    assert.equal(review.actionURL,card.actionURL);
    assert.ok(safeURL(review.corroborationURL));
    assert.ok(review.finding && review.limits && review.evidenceType && review.serviceType);
  }
});
test('deadline expires exactly at the boundary and reopening does not reset it',()=>{const c=cards.find(c=>c.endsAt);assert.equal(availability(c,Date.parse(c.endsAt)),'Ended');assert.equal(availability(c,Date.parse(c.endsAt)+86400000),'Ended');});
test('future reviews, missing reviews and closed cards never look current',()=>{const c=cards[0],now=Date.parse(c.checkedAt);assert.equal(availability(c,now-1),'Needs review');assert.equal(availability({...c,reviewBy:null},now),'Needs review');assert.equal(availability({...c,state:'resolved'},now),'Closed');assert.equal(availability(c,Date.parse(c.reviewBy)),'Recheck needed');});
test('feedback and source links reject script URLs and untrusted query fragments',()=>{assert.equal(safeURL('javascript:alert(1)'),null);assert.equal(safeURL('https://a:b@example.com'),null);assert.throws(()=>feedbackURL('../bad','helped'));assert.throws(()=>feedbackURL('211','delete'));assert.equal(feedbackURL('211','correction'),'/submit-story/?community=211&feedback=correction');});

test('changed wording cannot reuse an earlier source review',()=>{const c=cards[0];assert.equal(availability({...c,message:'A new unsupported claim'},Date.parse(c.checkedAt)),'Needs review');});
