// Optional context is evidence, never instructions. Only its original uploader's
// one-time capability can attach it to a manifest; media/identity cannot change.
const { createHash, timingSafeEqual } = require('node:crypto');
const { sanitizeSubmission } = require('./tipline-helpers');
const FIELDS = new Set(['contextToken', 'anonymous', 'nameUsageConsent', 'detailsStatus', 'whatHappened', 'timing', 'location', 'senderName', 'senderContact']);
function verifyContext(manifest, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !FIELDS.has(k))) throw new Error('INVALID_CONTEXT');
    if (!/^[a-f0-9]{64}$/.test(manifest.contextKeyHash || '') || !/^[a-f0-9]{64}$/.test(input.contextToken || '')) throw new Error('INVALID_CONTEXT_CAPABILITY');
    const digest = createHash('sha256').update(input.contextToken).digest();
    if (!timingSafeEqual(digest, Buffer.from(manifest.contextKeyHash, 'hex'))) throw new Error('INVALID_CONTEXT_CAPABILITY');
    if (input.detailsStatus !== 'provided' || typeof input.anonymous !== 'boolean' || input.nameUsageConsent !== (input.anonymous ? 'anonymous' : 'use_name')) throw new Error('INVALID_CONTEXT_CONSENT');
    for (const [key, limit] of Object.entries({ whatHappened:2000, timing:300, location:300, senderName:180, senderContact:220 })) {
        if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > limit)) throw new Error('INVALID_CONTEXT_FIELD');
    }
    if (!input.anonymous && !input.senderName?.trim()) throw new Error('INVALID_CONTEXT_CONSENT');
    const clean = sanitizeSubmission({ anonymous:input.anonymous, senderName:input.senderName, senderContact:input.senderContact,
        whatHappened:input.whatHappened, timing:input.timing, location:input.location });
    return { anonymous:clean.anonymous, nameUsageConsent:input.nameUsageConsent, detailsStatus:'provided',
        whatHappened:clean.whatHappened, timing:clean.timing, location:clean.location,
        description:[clean.whatHappened, clean.timing && `When: ${clean.timing}`, clean.location && `Where: ${clean.location}`].filter(Boolean).join('\n\n'),
        ...(clean.anonymous ? {} : {senderName:clean.senderName, senderContact:clean.senderContact}) };
}
function contextDocuments(context, bucketName) {
    const s = context.submission;
    const text = ['ADDITIONAL DETAILS FOR THIS EXISTING TIP', 'Received: ' + context.receivedAt,
        'These are unverified claims supplied after the media upload. Originals remain unchanged.', '', s.description || '(No incident details supplied)', '',
        s.anonymous ? 'Source requests anonymity. Do not name the source.' : 'Source consented to name use: ' + s.senderName,
        ...(!s.anonymous && s.senderContact ? ['PRIVATE follow-up contact, never publish: ' + s.senderContact] : [])].join('\n');
    return [['00_ADDITIONAL_TIP_CONTEXT.txt','text/plain',text], ['_additional_tip_context.json','application/json',JSON.stringify(context,null,2)]].map(([name,mimeType,body]) => {
        const inlineBytes=Buffer.from(body);
        return {name,mimeType,inlineBytes,sizeBytes:inlineBytes.length,md5Hash:createHash('md5').update(inlineBytes).digest('base64'),
            url:`https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(context.submissionName.replace('_submission.json','_context_ready.json'))}?alt=media`};
    });
}
module.exports={verifyContext,contextDocuments};
