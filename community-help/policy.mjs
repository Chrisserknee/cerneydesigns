export function safeURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function availability(card, now = Date.now()) {
  const checked = Date.parse(card.checkedAt), due = Date.parse(card.reviewBy), end = card.endsAt ? Date.parse(card.endsAt) : Infinity;
  if (card.state === 'resolved') return 'Closed';
  if (Number.isFinite(end) && now >= end) return 'Ended';
  if (card.state !== 'reviewed' || !Number.isFinite(checked) || checked > now || !Number.isFinite(due) || due <= checked || !safeURL(card.sourceURL) || !safeURL(card.actionURL)) return 'Needs review';
  return now >= due ? 'Recheck needed' : 'Source checked';
}
export function feedbackURL(id, kind) {
  if (!/^[a-z0-9-]{1,80}$/.test(id) || !['helped','correction'].includes(kind)) throw new Error('Invalid feedback link');
  return '/submit-story/?' + new URLSearchParams({community:id,feedback:kind});
}
