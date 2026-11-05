export function fingerprint(card) {
  const encoder = new TextEncoder();
  const end = card.endsAt ? (Date.parse(card.endsAt) / 1000).toFixed(1) : '';
  const fields = ['id','series','title','message','area','details','sourceName','sourceURL','actionURL','evidence','photoID'].map(k=>card[k] || '').concat([card.relatedStoryID || '',card.publicPageURL || '',end]);
  let hash = 14695981039346656037n;
  for (const byte of encoder.encode(fields.map(v=>`${encoder.encode(v).length}:${v}`).join(''))) hash = BigInt.asUintN(64,(hash ^ BigInt(byte)) * 1099511628211n);
  return hash.toString(16);
}
export function safeURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function availability(card, now = Date.now()) {
  const checked = Date.parse(card.checkedAt), due = Date.parse(card.reviewBy), end = card.endsAt ? Date.parse(card.endsAt) : Infinity;
  if (card.state === 'resolved') return 'Closed';
  if (Number.isFinite(end) && now >= end) return 'Ended';
  if (card.state !== 'reviewed' || card.reviewedFingerprint !== fingerprint(card) || !Number.isFinite(checked) || checked > now || !Number.isFinite(due) || due <= checked || !safeURL(card.sourceURL) || !safeURL(card.actionURL)) return 'Needs review';
  return now >= due ? 'Recheck needed' : 'Source checked';
}
export function feedbackURL(id, kind) {
  if (!/^[a-z0-9-]{1,80}$/.test(id) || !['helped','correction'].includes(kind)) throw new Error('Invalid feedback link');
  return '/submit-story/?' + new URLSearchParams({community:id,feedback:kind});
}
