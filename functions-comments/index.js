'use strict';
const {initializeApp} = require('firebase-admin/app');
const {getStorage} = require('firebase-admin/storage');
const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const {createHmac, timingSafeEqual} = require('node:crypto');
const {createCommentsService} = require('./core');
initializeApp();
const proxySecret = defineSecret('TIP_ALERTS_PROXY_SECRET');
const bucket = () => getStorage().bucket('tip-line-8c2d7.firebasestorage.app');
const ROOT = '_news/comments-v1/';
async function readPath(path) {
  try {
    const [metadata] = await bucket().file(path).getMetadata();
    const [bytes] = await bucket().file(path, {generation: metadata.generation}).download();
    return {data: JSON.parse(bytes.toString()), generation: metadata.generation};
  } catch (error) { if (Number(error.code) === 404) return null; throw error; }
}
const store = {
  read: key => readPath(ROOT + key),
  async write(key, data, generation) {
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error('Record limit');
    await bucket().file(ROOT + key).save(json, {resumable: false, contentType: 'application/json', metadata: {cacheControl: 'no-store'}, preconditionOpts: {ifGenerationMatch: generation}});
  },
  async catalog() { return (await readPath('_news/v1/catalog.json'))?.data || {posts: []}; },
  async listThreads() {
    // The public API cannot enumerate this private review queue.
    const [files] = await bucket().getFiles({prefix: ROOT + 'threads/', maxResults: 301, autoPaginate: false});
    if (files.length > 300) throw Object.assign(new Error('Review queue is too large. Contact support.'), {status: 429});
    const records = [];
    for (let i = 0; i < files.length; i += 15) records.push(...await Promise.all(files.slice(i,i+15).map(f => readPath(f.name))));
    return records.filter(Boolean).map(r => r.data);
  }
};
const service = createCommentsService({store, secret: () => proxySecret.value()});
function signedAdmin(req) {
  const timestamp = String(req.headers['x-tip-timestamp'] || ''), signature = String(req.headers['x-tip-signature'] || '');
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60000 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', proxySecret.value()).update(timestamp + '.').update(req.rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex')) && req.body?.scope === 'comments-v1';
}
exports.newsComments = onRequest({region: 'us-west1', memory: '256MiB', maxInstances: 3, timeoutSeconds: 60, invoker: 'public', secrets: [proxySecret]}, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const origin = req.get('Origin');
  if (origin && !['https://www.chriscerney.org','http://localhost:8081','http://127.0.0.1:8081'].includes(origin)) return res.status(403).json({error: 'Request origin is not allowed.'});
  if (origin) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') { res.set('Access-Control-Allow-Methods', 'POST'); res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization'); return res.status(204).end(); }
  if (req.method !== 'POST') return res.status(405).json({error: 'Use POST.'});
  if (!req.is('application/json') || req.rawBody?.length > 8192 || !req.body || Array.isArray(req.body)) return res.status(400).json({error: 'Invalid request.'});
  const admin = typeof req.body.op === 'string' && req.body.op.startsWith('admin-') && signedAdmin(req);
  const token = /^Bearer ([a-f0-9]{64})$/.exec(req.get('Authorization') || '')?.[1];
  const clientKey = createHmac('sha256', proxySecret.value()).update('comments-network:' + String(req.ip)).digest('hex');
  try { return res.json(await service.handle(req.body, {admin, token, clientKey})); }
  catch (error) {
    const status = [400,401,403,404,409,429].includes(error.status) ? error.status : 503;
    return res.status(status).json({error: status === 503 ? 'Comments are temporarily unavailable. Please try again.' : error.message});
  }
});
