'use strict';
const { billingTerms, customPlan } = require('./spotlight-custom-plans');
// Only call after canonical paid/approved publication checks. No customer-entered
// profile field or metadata label can grant a badge or an exclusivity claim.
function membershipBadge(subscription, settings) {
    if (billingTerms(subscription, settings).amount < 25000) return '';
    return customPlan(subscription, settings)?.key === 'hare-250-v1'
        ? 'exclusive-construction' : 'featured-partner';
}
module.exports = { membershipBadge };
