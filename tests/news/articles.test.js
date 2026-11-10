'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {isArticle, textSegments, articlePage, relatedLink, keepVisible, isEditorNote} = require('../../news/article-utils');
const video = id => ({id, media: [{type: 'video/mp4'}, {type: 'image/jpeg'}]});
const article = id => ({id, media: [{type: 'image/jpeg'}]});

test('video posters do not make a video an article', () => {
  assert.equal(isArticle(video('v')), false);
  assert.equal(isArticle(article('a')), true);
  assert.equal(isArticle({media: []}), true);
});

test('article discovery uses server offsets across pages of videos', async () => {
  const calls = [];
  const pages = {0: {posts: Array.from({length: 30}, (_, i) => video('v'+i)), nextOffset: 30}, 30: {posts: [article('a')], nextOffset: 60}, 60: {posts: [article('b')], nextOffset: null}};
  const fetch = async offset => {calls.push(offset); return pages[offset];};
  const first = await articlePage(fetch, 0);
  assert.deepEqual(first, {posts: [article('a')], nextOffset: 60});
  const second = await articlePage(fetch, first.nextOffset);
  assert.deepEqual(second, {posts: [article('b')], nextOffset: null});
  assert.deepEqual(calls, [0, 30, 60]);
});

test('no matching articles and canceled searches finish without a false page', async () => {
  assert.deepEqual(await articlePage(async () => ({posts: [video('v')], nextOffset: null}), 0), {posts: [], nextOffset: null});
  let current = true, calls = 0;
  const result = await articlePage(async () => {calls++; current = false; return {posts: [article('a')], nextOffset: 30};}, 0, () => current);
  assert.equal(calls, 1);
  assert.deepEqual(result, {posts: [], nextOffset: null});
});

test('caption links preserve punctuation and leave markup and unsafe schemes as text', () => {
  const text = '<img src=x onerror=alert(1)> javascript:alert(1) https://example.com/a?post=123. Also (https://example.com/story).';
  const segments = textSegments(text);
  assert.equal(segments.map(segment => segment.text).join(''), text);
  assert.deepEqual(segments.filter(segment => segment.url).map(segment => segment.url), ['https://example.com/a?post=123', 'https://example.com/story']);
  assert.deepEqual(textSegments('http://example.com javascript:alert(1)'), [{text: 'http://example.com javascript:alert(1)'}]);
});

test('paired links are recognized in both one-line and line-break label forms', () => {
  assert.deepEqual(relatedLink('Watch the corresponding video report: https://www.chriscerney.org/news/?post=a'), {label: 'Watch the corresponding video report', url: 'https://www.chriscerney.org/news/?post=a'});
  assert.deepEqual(relatedLink('Watch the full video report:\nhttps://www.chriscerney.org/news/?post=b'), {label: 'Watch the full video report', url: 'https://www.chriscerney.org/news/?post=b'});
  assert.deepEqual(relatedLink('Read the accompanying article:\nhttps://www.chriscerney.org/news/?post=c\n'), {label: 'Read the accompanying article', url: 'https://www.chriscerney.org/news/?post=c'});
  assert.equal(relatedLink('Watch the full video report: http://example.com'), null);
  assert.equal(relatedLink('Prosecutors say the video report: https://example.com was reviewed.'), null);
});

test('folded copy keeps source attribution and paired links visible', () => {
  assert.equal(keepVisible('Source: Monterey County District Attorney\u2019s Office, November 9, 2026.\nhttps://www.countyofmonterey.gov/x'), true);
  assert.equal(keepVisible('Read the accompanying article:\nhttps://www.chriscerney.org/news/?post=c'), true);
  assert.equal(keepVisible('Original TikTok publication: https://www.tiktok.com/@chriscerney/video/1'), true);
  assert.equal(keepVisible('Witnesses gave conflicting accounts of who fired first.'), false);
});

test('only explicit dated notes get the small note style; reporting ledes stay body size', () => {
  for (const note of ['Originally reported November 8, 2026. This account reflects the Seaside Police Department statement.', 'From our October 24, 2026 report.', 'From our October 25, 2026 report. October 25 is the report\'s publication date.', 'Sponsored feature. Originally published October 22, 2026.']) assert.equal(isEditorNote(note), true, note);
  assert.equal(isEditorNote('The Monterey County District Attorney\u2019s Office is detailing alleged necklace thefts, gang insults and conflicting accounts.'), false);
  assert.equal(isEditorNote('From our reporting, investigators said the road was closed.'), false);
});
