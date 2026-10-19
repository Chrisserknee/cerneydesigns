'use strict';
const {createHmac}=require('node:crypto');
const {isAuthenticated}=require('./_lib/admin-auth');
const {bodyIsTooLarge,parseBody,sendJson}=require('./_lib/http');
const SITE='https://www.chriscerney.org';
const BACKEND='https://us-west1-tip-line-8c2d7.cloudfunctions.net/newsApi';
const COOKIE='cc_news_session';
const cookie=value=>`${COOKIE}=${value}; Max-Age=${value ? 2592000 : 0}; Path=/api/news; HttpOnly; Secure; SameSite=Strict`;
const readCookie=req=>String(req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1) || '';
const escapeXml=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
function rss(posts) {
    return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Chris Cerney — News</title><link>'+SITE+'/news/</link><description>Independent reporting from Chris Cerney.</description>'+posts.map(p=>`<item><guid isPermaLink="true">${escapeXml(p.permalink)}</guid><title>${escapeXml(p.title)}</title><link>${escapeXml(p.permalink)}</link><description>${escapeXml(p.caption)}</description><pubDate>${new Date(p.publishAt).toUTCString()}</pubDate></item>`).join('')+'</channel></rss>';
}
module.exports=async(req,res)=>{
    const secret=process.env.TIP_ALERTS_PROXY_SECRET || '';
    if (secret.length<32) return sendJson(res,503,{error:'The news service is temporarily unavailable.'});
    let body;
    if (req.method==='GET') {
        if (!['feed','rss'].includes(req.query?.op || 'feed')) return sendJson(res,400,{error:'Unknown request.'});
        body={op:'feed',id:req.query?.id,offset:req.query?.offset,type:req.query?.type,query:req.query?.q};
    } else if (req.method==='POST') {
        if (req.headers.origin!==SITE) return sendJson(res,403,{error:'Request origin is not allowed.'});
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res,415,{error:'JSON request required.'});
        if (bodyIsTooLarge(req,60*1024)) return sendJson(res,413,{error:'Request too large.'});
        try { body=parseBody(req); } catch { return sendJson(res,400,{error:'Invalid JSON.'}); }
        if (!body || Array.isArray(body) || typeof body!=='object') return sendJson(res,400,{error:'Invalid request.'});
    } else return sendJson(res,405,{error:'Method not allowed.'});
    const allowed=['feed','admin-list','admin-upload','admin-save','admin-preview','admin-export','signin','confirm','unsubscribe','status','saved-feed','save-story','preferences','logout','delete-account'];
    if (!allowed.includes(body.op)) return sendJson(res,400,{error:'Unknown request.'});
    // Never trust an admin flag, session, scope or network identity from JSON.
    const payload={...body,scope:'news-v1',admin:false,session:readCookie(req),clientKey:''};
    if (body.op.startsWith('admin-')) {
        if (!isAuthenticated(req)) return sendJson(res,401,{error:'Sign in as the administrator.'});
        payload.admin=true;
    }
    if (body.op==='signin') {
        const ip=String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0,100);
        payload.clientKey=createHmac('sha256',secret).update('news-ip:'+ip).digest('hex');
    }
    try {
        const raw=JSON.stringify(payload),timestamp=String(Date.now());
        const signature=createHmac('sha256',secret).update(timestamp+'.'+raw).digest('hex');
        const response=await fetch(BACKEND,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers:{'Content-Type':'application/json','X-Tip-Timestamp':timestamp,'X-Tip-Signature':signature},body:raw});
        const result=await response.json();
        if (response.ok && body.op==='confirm') {
            if (!/^[A-Za-z0-9_-]{43}$/.test(result.sessionToken || '')) throw new Error('Invalid session');
            res.setHeader('Set-Cookie',cookie(result.sessionToken));delete result.sessionToken;
        }
        if (response.ok && ['logout','delete-account'].includes(body.op)) res.setHeader('Set-Cookie',cookie(''));
        if (response.ok && req.method==='GET' && req.query?.op==='rss') {
            res.setHeader('Content-Type','application/rss+xml; charset=utf-8');res.setHeader('Cache-Control','public, max-age=30');
            res.status(200);return res.end(rss(result.posts));
        }
        return sendJson(res,response.status,result,req.method==='GET' && response.ok ? 'public, max-age=15, s-maxage=15' : 'no-store');
    } catch { return sendJson(res,503,{error:'Could not reach the news platform. Please try again.'}); }
};
module.exports.rss=rss;
