'use strict';
const { initializeApp, getApps } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString, defineBoolean } = require('firebase-functions/params');
const { createStore } = require('./storage');
const { createGateway } = require('./gateway');
const { createLogoGateway } = require('./logos-gateway');
const { createLogoService } = require('./logos');

if (!getApps().length) initializeApp();
const proxySecret = defineSecret('SPOTLIGHT_MODERATION_PROXY_SECRET');
const reviewSecret = defineSecret('SPOTLIGHT_REVIEW_SECRET');
const stripeKey = defineSecret('SPOTLIGHT_STRIPE_SECRET_KEY');
const resendKey = defineSecret('SPONSORSHIP_RESEND_API_KEY');
const priceId = defineString('SPOTLIGHT_PRICE_ID', { default: '' });
const siteUrl = defineString('SPOTLIGHT_SITE_URL', { default: 'https://cerneydesigns-git-codex-local-spotlight-chris-projects-1637f7b0.vercel.app' });
const emailEnabled = defineBoolean('SPOTLIGHT_EMAIL_ENABLED', { default: false });
const billingEnabled = defineBoolean('SPOTLIGHT_MEMBER_BILLING_ENABLED', { default: false });
const featuredPrice = defineString('SPOTLIGHT_FEATURED_PRICE_ID', { default: '' });
const mustachePrice = defineString('SPOTLIGHT_MUSTACHE_PRICE_ID', { default: '' });
const setupPrice = defineString('SPOTLIGHT_SETUP_PRICE_ID', { default: '' });
const options = { region: 'us-west1', memory: '256MiB', timeoutSeconds: 120, maxInstances: 3, concurrency: 8 };
const secrets = [reviewSecret, stripeKey, resendKey];

function sandboxSettings() {
    // These functions are sandbox-only. Provision separate live resources later.
    const key = stripeKey.value();
    if (!/^(?:rk|sk)_test_/.test(key || '')) throw new Error('Sandbox Stripe configuration required.');
    return { stripeKey: key, priceId: priceId.value(), siteUrl: siteUrl.value(), reviewSecret: reviewSecret.value(), resendKey: resendKey.value(), emailEnabled: emailEnabled.value(), ownerEmail: 'cerneymedia@gmail.com', billingEnabled: billingEnabled.value() };
}
function moderation() {
    const settings = sandboxSettings();
    const store = createStore({ bucket: getStorage().bucket('tip-line-8c2d7.firebasestorage.app'), prefix: '_spotlight/v1/sandbox/applications/' });
    const { createModeration } = require('./moderation');
    const { createProviders } = require('./providers');
    return createModeration({ store, settings, providers: createProviders({ settings }) });
}
function memberExtras() {
    const settings = { ...sandboxSettings(), featuredPriceId: featuredPrice.value(), mustachePriceId: mustachePrice.value(), setupPriceId: setupPrice.value() };
    const { createMemberExtras } = require('./member-extras');
    const { createProviders } = require('./providers');
    const store = createStore({ bucket: getStorage().bucket('tip-line-8c2d7.firebasestorage.app'), prefix: '_spotlight/v1/sandbox/member-extras/' });
    const { createMemberBilling } = require('./member-billing');
    const { createBillingProvider } = require('./member-billing-provider');
    const slots = createStore({ bucket: getStorage().bucket('tip-line-8c2d7.firebasestorage.app'), prefix: '_spotlight/v1/sandbox/member-slots/' });
    const billing = createMemberBilling({ store, slots, settings, payments: createBillingProvider({ settings }) });
    return createMemberExtras({ store, settings, billing, providers: createProviders({ settings }) });
}

exports.spotlightModerationApi = onRequest({ ...options, secrets: [proxySecret, ...secrets] }, createGateway({ getSecret: () => proxySecret.value(), makeModeration: moderation, makeMemberExtras: memberExtras }));
exports.retrySpotlightModeration = onSchedule({ ...options, schedule: 'every 5 minutes', secrets, retryCount: 0 }, async () => {
    try { await moderation().retry(); await memberExtras().retry(); }
    catch { console.error('Spotlight moderation retry needs attention.'); throw new Error('Moderation retry failed.'); }
});
exports.spotlightLogoApi = onRequest({
    region: 'us-west1', memory: '512MiB', timeoutSeconds: 60, maxInstances: 2, concurrency: 1,
    secrets: [proxySecret],
}, createLogoGateway({
    getSecret: () => proxySecret.value(),
    makeLogos: () => createLogoService({ bucket: getStorage().bucket('tip-line-8c2d7.firebasestorage.app') }),
}));
