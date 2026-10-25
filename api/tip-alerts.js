'use strict';
const { isAuthenticated } = require('./_lib/admin-auth');
const { parseBody, sendJson } = require('./_lib/http');
const {callTipBackend}=require('./_lib/tip-backend');
const COOKIE = 'cc_tip_device';
const deviceCookie = (token, maxAge = 34560000) => `${COOKIE}=${token}; Max-Age=${maxAge}; Path=/api/tip-alerts; HttpOnly; Secure; SameSite=Strict`;
function readCookie(request, name) {
    return String(request.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1) || '';
}
module.exports = async (request, response) => {
    if (request.method !== 'POST') return sendJson(response,405,{error:'Method not allowed.'});
    const origin = request.headers.origin;
    if (origin !== 'https://www.chriscerney.org') return sendJson(response,403,{error:'Request origin is not allowed.'});
    if (!String(request.headers['content-type'] || '').startsWith('application/json')) return sendJson(response,415,{error:'JSON request required.'});
    let body;
    try { body = parseBody(request); if (Buffer.byteLength(JSON.stringify(body)) > (body?.op==='producer-media-part'?2900000:body?.op==='producer-media-finish'?100000:String(body?.op||'').startsWith('field-')?780000:String(body?.op||'').startsWith('producer-')?30000:8192)) return sendJson(response,413,{error:'Request too large.'}); }
    catch { return sendJson(response,400,{error:'Invalid request.'}); }
    const ops = ['pair','status','subscribe','unsubscribe','logout','list','tip','test','devices','revoke-device','thumbnail','newsroom','field-save','field-get','field-audio-part','field-audio-finish','field-audio-read','producer-catalog','producer-list','producer-get','producer-send','producer-cancel','producer-media-part','producer-media-finish','producer-media-status','producer-artifact'];
    if (!ops.includes(body?.op)) return sendJson(response,400,{error:'Unknown request.'});
    let payload;
    if (body.op === 'pair') {
        if (!isAuthenticated(request)) return sendJson(response,401,{error:'Sign in to pair this device.'});
        payload = {op:'pair',adminCookie:`cc_admin_session=${readCookie(request,'cc_admin_session')}`,userAgent:String(request.headers['user-agent'] || '')};
    } else {
        const token = readCookie(request,COOKIE);
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return sendJson(response,401,{error:'Sign in to connect this device.'});
        payload = {op:body.op,token,...(body.op === 'subscribe' ? {subscription:body.subscription} : {}),...(['tip','revoke-device','thumbnail'].includes(body.op) ? {id:body.id} : {})};
        if(String(body.op).startsWith('field-'))Object.assign(payload,{id:body.id,note:body.note,expectedRevision:body.expectedRevision,index:body.index,sha256:body.sha256,base64:body.base64,parts:body.parts,mimeType:body.mimeType});
        if(String(body.op).startsWith('producer-'))for(const key of ['id','requestID','title','text','preferences','sourceRefs','assetIDs','assetID','index','sha256','base64','parts','mimeType','filename','bytes','cursor','artifactID','checksumMode'])if(body[key]!==undefined)payload[key]=body[key];
        if (body.op === 'thumbnail') Object.assign(payload,{generation:body.generation,sha256:body.sha256,revision:body.revision,contextVersion:body.contextVersion});
    }
    try {
        const remote = await callTipBackend(payload);
        const result = await remote.json();
        // Count-only diagnostics distinguish a missing backend report list from
        // an older/resumed client. Never log cookies, tip IDs, text or media.
        if (body.op === 'list') console.info(JSON.stringify({event:'tip-inbox-list',
            client:/iPhone|iPad|iPod/.test(String(request.headers['user-agent'] || ''))?'ios':'other',
            status:remote.status,tips:Array.isArray(result.tips)?result.tips.length:null,
            incidentTips:Array.isArray(result.tips)?result.tips.filter(t=>t.type==='incident').length:null,
            reports:Array.isArray(result.reports)?result.reports.length:null}));
        if (remote.ok && body.op === 'pair') {
            if (!/^[A-Za-z0-9_-]{43}$/.test(result.token)) throw new Error('Invalid pairing response');
            response.setHeader('Set-Cookie',deviceCookie(result.token));
            return sendJson(response,200,{authenticated:true,expiresAt:result.expiresAt});
        }
        if (remote.ok) response.setHeader('Set-Cookie',body.op === 'logout' ? deviceCookie('',0) : deviceCookie(payload.token));
        return sendJson(response,remote.status,result);
    } catch { return sendJson(response,503,{error:'Could not reach tip alerts. Please try again.'}); }
};
