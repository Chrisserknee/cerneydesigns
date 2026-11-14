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
  if (plan) return {priceId:plan.price,amount:plan.amount};
  if (settings.featuredMembershipPriceId && id(sub?.items?.data?.[0]?.price) === settings.featuredMembershipPriceId) return {priceId:settings.featuredMembershipPriceId,amount:25000};
  return {priceId:settings.priceId,amount:10000};
}
function invoiceTerms(sub, settings) {
  const plan = customPlan(sub, settings);
  const item = sub?.items?.data?.[0];
  if (plan?.autoUpgrade && id(sub.latest_invoice) === plan.initialInvoice && item.current_period_start === plan.periodStart && item.current_period_end === plan.periodEnd) return {priceId:settings.priceId,amount:10000,supplement:plan};
  return billingTerms(sub, settings);
}
function reviewDraft(applicationId) {
  const plan = plans().find(p => p.subscription === applicationId);
  return plan ? {initialAmount:15000,monthlyAmount:plan.amount,status:'The upgrade activates after the extra $150 is paid and the listing is approved. Check Stripe for current invoice and subscription status.',invoiceUrl:`https://dashboard.stripe.com/invoices/${plan.invoice}`,terms:'This includes your month-to-month exclusive construction spot and being featured in our business spotlight videos on Chris Cerney’s social media.'} : null;
}
module.exports = {plans,billingTerms,invoiceTerms,customPlan,reviewDraft};
