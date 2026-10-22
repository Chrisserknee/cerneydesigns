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
const options = { region: 'us-west1', memory: '512MiB', timeoutSeconds: 120, maxInstances: 3, concurrency: 2 };

// Production has its own credentials, signing keys and storage namespace. Keep
// the existing sandbox endpoints and records isolated for release testing.
const liveProxy = defineSecret('CERNEYSELECTS_MODERATION_PROXY_SECRET');
const liveReview = defineSecret('CERNEYSELECTS_REVIEW_SECRET');
const liveStripe = defineSecret('CERNEYSELECTS_STRIPE_SECRET_KEY');
const livePrice = defineString('CERNEYSELECTS_PRICE_ID', { default: '' });
const liveEmail = defineBoolean('CERNEYSELECTS_EMAIL_ENABLED', { default: false });
const liveBilling = defineBoolean('CERNEYSELECTS_MEMBER_BILLING_ENABLED', { default: false });
const featuredPrice = defineString('CERNEYSELECTS_FEATURED_PRICE_ID', { default: '' });
const mustachePrice = defineString('CERNEYSELECTS_MUSTACHE_PRICE_ID', { default: '' });
const setupPrice = defineString('CERNEYSELECTS_SETUP_PRICE_ID', { default: '' });
const liveSecrets = [liveReview, liveStripe, resendKey];

function liveSettings() {
    return {
        live: true, stripeKey: liveStripe.value(), priceId: livePrice.value(),
        siteUrl: 'https://cerneyselects.com', reviewSecret: liveReview.value(),
        resendKey: resendKey.value(), emailEnabled: liveEmail.value(),
        ownerEmail: 'cerneymedia@gmail.com', billingEnabled: liveBilling.value(),
    };
}
function liveModeration() {
    const settings = liveSettings();
    const store = createStore({ bucket: getStorage().bucket('tip-line-8c2d7.firebasestorage.app'), prefix: '_spotlight/v1/live/applications/' });
    const { createModeration } = require('./_shared/moderation');
    const { createProviders } = require('./_shared/providers');
    const { createWebsiteBanners } = require('./_shared/website-banners');
    const banners = createWebsiteBanners({ bucket: getStorage().bucket('tip-line-8c2d7.firebasestorage.app'), live: true });
    return createModeration({ store, settings, banners, providers: createProviders({ settings }) });
}
function liveMemberExtras() {
    const settings = { ...liveSettings(), featuredPriceId: featuredPrice.value(), mustachePriceId: mustachePrice.value(), setupPriceId: setupPrice.value() };
    const { createMemberExtras } = require('./_shared/member-extras');
    const { createProviders } = require('./_shared/providers');
    const store = createStore({ bucket: getStorage().bucket('tip-line-8c2d7.firebasestorage.app'), prefix: '_spotlight/v1/live/member-extras/' });
    const { createMemberBilling } = require('./_shared/member-billing');
    const { createBillingProvider } = require('./_shared/member-billing-provider');
    const slots = createStore({ bucket: getStorage().bucket('tip-line-8c2d7.firebasestorage.app'), prefix: '_spotlight/v1/live/member-slots/' });
    const billing = createMemberBilling({ store, slots, settings, payments: createBillingProvider({ settings }) });
    return createMemberExtras({ store, settings, billing, providers: createProviders({ settings }) });
}

exports.cerneySelectsModerationApi = onRequest({ ...options, secrets: [liveProxy, ...liveSecrets] }, createGateway({ getSecret: () => liveProxy.value(), makeModeration: liveModeration, makeMemberExtras: liveMemberExtras }));
exports.retryCerneySelectsModeration = onSchedule({ ...options, schedule: 'every 5 minutes', secrets: liveSecrets, retryCount: 0 }, async () => {
    try { await liveModeration().retry(); await liveMemberExtras().retry(); }
    catch { console.error('Cerney Selects moderation retry needs attention.'); throw new Error('Moderation retry failed.'); }
});
exports.cerneySelectsLogoApi = onRequest({
    region: 'us-west1', memory: '512MiB', timeoutSeconds: 60, maxInstances: 2, concurrency: 1,
    secrets: [liveProxy],
}, createLogoGateway({
    getSecret: () => liveProxy.value(),
    makeLogos: () => createLogoService({ bucket: getStorage().bucket('tip-line-8c2d7.firebasestorage.app'), live: true }),
}));
