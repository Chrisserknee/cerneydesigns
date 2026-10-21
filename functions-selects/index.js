'use strict';
const { initializeApp, getApps } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString, defineBoolean } = require('firebase-functions/params');
const { createStore } = require('./_shared/storage');
const { createGateway } = require('./_shared/gateway');
const { createLogoGateway } = require('./_shared/logos-gateway');
const { createLogoService } = require('./_shared/logos');
if (!getApps().length) initializeApp();
const resendKey = defineSecret('SPONSORSHIP_RESEND_API_KEY');
const options = { region: 'us-west1', memory: '256MiB', timeoutSeconds: 120, maxInstances: 3, concurrency: 8 };

// Production has its own credentials, signing keys and storage namespace. Keep
// the existing sandbox endpoints and records isolated for release testing.
const liveProxy = defineSecret('CERNEYSELECTS_MODERATION_PROXY_SECRET');
const liveReview = defineSecret('CERNEYSELECTS_REVIEW_SECRET');
const liveStripe = defineSecret('CERNEYSELECTS_STRIPE_SECRET_KEY');
const livePrice = defineString('CERNEYSELECTS_PRICE_ID', { default: '' });
const liveEmail = defineBoolean('CERNEYSELECTS_EMAIL_ENABLED', { default: false });
const liveSecrets = [liveReview, liveStripe, resendKey];

function liveModeration() {
    const settings = {
        live: true, stripeKey: liveStripe.value(), priceId: livePrice.value(),
        siteUrl: 'https://cerneyselects.com', reviewSecret: liveReview.value(),
        resendKey: resendKey.value(), emailEnabled: liveEmail.value(),
        ownerEmail: 'cerneymedia@gmail.com',
    };
    const store = createStore({ bucket: getStorage().bucket('tip-line-8c2d7.firebasestorage.app'), prefix: '_spotlight/v1/live/applications/' });
    const { createModeration } = require('./_shared/moderation');
    const { createProviders } = require('./_shared/providers');
    return createModeration({ store, settings, providers: createProviders({ settings }) });
}

exports.cerneySelectsModerationApi = onRequest({ ...options, secrets: [liveProxy, ...liveSecrets] }, createGateway({ getSecret: () => liveProxy.value(), makeModeration: liveModeration }));
exports.retryCerneySelectsModeration = onSchedule({ ...options, schedule: 'every 5 minutes', secrets: liveSecrets, retryCount: 0 }, async () => {
    try { await liveModeration().retry(); }
    catch { console.error('CerneySelects moderation retry needs attention.'); throw new Error('Moderation retry failed.'); }
});
exports.cerneySelectsLogoApi = onRequest({
    region: 'us-west1', memory: '512MiB', timeoutSeconds: 60, maxInstances: 2, concurrency: 1,
    secrets: [liveProxy],
}, createLogoGateway({
    getSecret: () => liveProxy.value(),
    makeLogos: () => createLogoService({ bucket: getStorage().bucket('tip-line-8c2d7.firebasestorage.app'), live: true }),
}));
