'use strict';
const { createHmac } = require('node:crypto');
const { isIP } = require('node:net');

/** New, explicit native route. Existing browser origin policy remains unchanged. */
function createMobileTipUploadHandler({ callTipBackend, env = process.env }) {
  return async function mobileTipUpload(req, res) {
    const send = (status, body) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      return res.status(status).json(body);
    };
    if (env.TIPLINE_MOBILE_UPLOADS_ENABLED !== 'true') return send(503, { error: 'In-app tip uploads are not enabled yet.' });
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
    // Native clients send no Origin. Requests from ordinary web pages cannot
    // use this route to evade the web gateway. This is not device attestation.
    if (req.headers.origin) return send(403, { error: 'Use the website upload endpoint for browser uploads.' });
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(415, { error: 'JSON required.' });
    let body;
    try {
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!raw || Buffer.byteLength(raw) > 8192) throw Error();
      body = typeof req.body === 'string' ? JSON.parse(raw) : req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
    } catch { return send(400, { error: 'Invalid request.' }); }
    // Use the same platform-owned IP header and namespace as the website.
    // Client-supplied keys, forwarded headers and shared app secrets are ignored.
    const ip = String(req.headers['x-vercel-forwarded-for'] || '').trim();
    const secret = env.TIP_ALERTS_PROXY_SECRET || '';
    if (!isIP(ip) || secret.length < 32) return send(503, { error: 'Upload protection unavailable. Please try again.' });
    const clientKey = createHmac('sha256', secret).update('upload-ip:' + ip).digest('hex');
    try {
      const response = await callTipBackend({ op: 'upload-authorize', clientKey, session: body.session, files: body.files });
      return send(response.status, await response.json());
    } catch { return send(503, { error: 'Could not start the upload. Please try again.' }); }
  };
}
module.exports = { createMobileTipUploadHandler };
