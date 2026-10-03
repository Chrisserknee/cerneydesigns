'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
function gatewayAuthenticated(req, secret, now=Date.now()) {
    const timestamp=String(req.headers?.['x-tip-timestamp'] || '');
    const signature=String(req.headers?.['x-tip-signature'] || '');
    if(typeof secret!=='string' || secret.length<32 || !/^\d{13}$/.test(timestamp)
        || Math.abs(now-Number(timestamp))>60000 || !/^[a-f0-9]{64}$/.test(signature)
        || !Buffer.isBuffer(req.rawBody))return false;
    const expected=createHmac('sha256',secret).update(timestamp+'.').update(req.rawBody).digest();
    return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
module.exports={gatewayAuthenticated};
