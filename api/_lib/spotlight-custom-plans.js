"use strict";
// Server-only configuration. Customer billing identifiers stay out of source.
const id = value => typeof value === 'string' ? value : value?.id;
function plans() {
  let values; try { values = JSON.parse(process.env.SPOTLIGHT_CUSTOM_PLANS_JSON || '[]'); } catch { return []; }
  if (!Array.isArray(values) || values.length > 100) return [];
  return values.filter(p => p && /^sub_[A-Za-z0-9]+$/.test(p.subscription) && /^cus_[A-Za-z0-9]+$/.test(p.customer) && /^price_[A-Za-z0-9]+$/.test(p.price) && /^in_[A-Za-z0-9]+$/.test(p.invoice) && p.amount === 25000 && p.key === 'hare-250-v1');
}
function customPlan(sub, settings) {
  return settings.live === true && sub?.livemode === true ? plans().find(p => sub.id === p.subscription && id(sub.customer) === p.customer && sub.items?.data?.[0]?.price?.id === p.price) || null : null;
}
function billingTerms(sub, settings) {
  const plan = customPlan(sub, settings);
  return plan ? {priceId:plan.price,amount:plan.amount} : {priceId:settings.priceId,amount:10000};
}
function reviewDraft(applicationId) {
  const plan = plans().find(p => p.subscription === applicationId);
  return plan ? {initialAmount:15000,monthlyAmount:plan.amount,status:'Prepared proposal. Listing approval alone does not activate this billing change. Check Stripe for current invoice and subscription status.',invoiceUrl:`https://dashboard.stripe.com/invoices/${plan.invoice}`,terms:'Construction exclusivity is month-to-month. Includes a feature alongside other local businesses in one of our regular weekly business spotlight videos, not a dedicated Hare video. Approximately 25,000 views is a target for the overall video, not a guarantee.'} : null;
}
module.exports = {billingTerms,customPlan,reviewDraft};
