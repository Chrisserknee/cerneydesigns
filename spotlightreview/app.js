'use strict';
(() => {
    const $ = id => document.getElementById(id);
    const fragment = new URLSearchParams(location.hash.slice(1));
    const token = fragment.get('token') || '';
    const suggested = fragment.get('action');
    // Keep the credential in memory, away from history, referrers, and server logs.
    history.replaceState(null, '', location.pathname);
    // A second emailed application can open in this same tab. Reload its new
    // fragment so the previous application's token and decision form are cleared.
    window.addEventListener('hashchange', () => { if (location.hash) location.reload(); });
    let state = null;
    let busy = false;
    let decisionNeedsRefresh = false;
    let refreshTimer;
    const form = $('decisionForm');
    const text = value => typeof value === 'string' ? value : '';
    function link(value) {
        try { const u = new URL(value); return u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password && !u.port && !u.hostname.endsWith('.local') && !/^[\d.]+$/.test(u.hostname) ? u.href : ''; } catch { return ''; }
    }
    function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
    function selected() { return form.elements.decision.value; }
    function updateChoice() {
        const decline = selected() === 'decline';
        $('reasonField').hidden = !decline; $('reason').required = decline;
        $('confirmed').checked = false;
        $('submitDecision').textContent = decline ? 'Confirm decline & refund $100' : selected() === 'approve' ? 'Confirm approval & publish' : 'Confirm decision';
        $('confirmationText').textContent = decline ? 'I confirm this decline, cancellation, and full $100 refund. My reason will be emailed to the applicant.' : 'I have reviewed this business and approve this profile for publication.';
    }
    async function request(payload) {
        const response = await fetch('/api/spotlight-review', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...payload, token }), signal: AbortSignal.timeout(30000) });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data) throw new Error(text(data?.error) || 'Review is temporarily unavailable. Refresh the status before trying again.');
        return data;
    }
    function render(data) {
        state = data;
        const profile = data.business || {};
        $('application').hidden = false;
        $('businessName').textContent = text(profile.businessName);
        $('businessCategory').textContent = text(profile.category);
        $('businessCity').textContent = text(profile.city);
        $('businessDescription').textContent = text(profile.description);
        $('customerEmail').textContent = text(data.customerEmail);
        $('businessPhone').textContent = text(profile.phone); $('phoneRow').hidden = !profile.phone;
        const url = link(profile.website); $('businessWebsite').textContent = url || 'No valid website';
        if (url) $('businessWebsite').href = url; else $('businessWebsite').removeAttribute('href');
        const initials = text(profile.businessName).split(/\s+/).slice(0,2).map(w => Array.from(w)[0] || '').join('').toUpperCase();
        $('businessMark').textContent = initials;
        const logo = link(profile.logoUrl);
        if (logo) { const img = document.createElement('img'); img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = logo; img.addEventListener('error', () => { $('businessMark').textContent = initials; }, { once: true }); $('businessMark').replaceChildren(img); }
        $('paidAmount').textContent = new Intl.NumberFormat('en-US', { style: 'currency', currency: data.currency || 'usd' }).format(Number(data.paidAmount || 0) / 100);
        const due = new Date(data.reviewDueAt);
        $('reviewDue').textContent = Number.isNaN(due.getTime()) ? '' : `Review by ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(due)}`;
        const labels = { pending: 'Awaiting your review', approving: 'Approval processing', approved: 'Approved', declining: 'Decline processing', declined: 'Declined', needs_attention: 'Needs attention' };
        $('reviewStatus').textContent = labels[data.status] || 'Checking status';
        form.hidden = data.decisionAllowed !== true;
        let summary = '';
        if (data.status === 'approved') summary = 'Approved. This reviewed profile is eligible for the directory while its subscription remains paid and active. The applicant’s confirmation email is queued or sent.';
        else if (data.status === 'approving') summary = 'Your approval has been saved. Publication and the confirmation email are being processed. Do not submit a different decision.';
        else if (['declining', 'declined'].includes(data.status)) summary = `Decline saved. ${data.refundStatus === 'succeeded' ? 'The full $100 refund has been issued and future billing is canceled. Your reason is included in the applicant’s email.' : data.refundNeedsAttention ? 'The refund needs your attention in Stripe. Check the owner notification email for instructions. Future billing is canceled; the applicant’s refund confirmation waits for Stripe to confirm success.' : 'Cancellation and the full $100 refund are being processed. We send the refund confirmation once Stripe confirms it succeeded.'}${data.reason ? `\n\nYour reason: ${data.reason}` : ''}`;
        else if (data.status === 'needs_attention') summary = 'Automatic processing has stopped for this application. A listing or payment change may already have completed. Check the recorded decision, the directory, and Stripe before taking further action. Do not issue a separate refund without checking the existing payment.';
        $('decisionSummary').textContent = summary; $('decisionSummary').hidden = !summary;
        notice(data.decisionAllowed ? 'Payment received. The business is hidden until you approve it.' : 'Your latest review status is shown below.');
        clearTimeout(refreshTimer);
        if (['approving', 'declining'].includes(data.status)) refreshTimer = setTimeout(load, 10000);
    }
    async function load() {
        if (busy) return;
        busy = true; $('refresh').disabled = true;
        try { render(await request({ op: 'review' })); decisionNeedsRefresh = false; } catch (error) { notice(error.message, true); }
        finally { busy = false; $('refresh').disabled = false; $('submitDecision').disabled = decisionNeedsRefresh; }
    }
    form.addEventListener('change', e => { if (e.target.name === 'decision') updateChoice(); });
    form.addEventListener('submit', async e => {
        e.preventDefault();
        if (busy || decisionNeedsRefresh || !state?.decisionAllowed || !$('confirmed').checked || !form.reportValidity()) return;
        const decision = selected(); const reason = $('reason').value.trim();
        if (decision === 'decline' && (!reason || /[\u0000-\u001f\u007f<>]/.test(reason))) { notice('Enter a plain-text decline reason without line breaks or markup.', true); return; }
        busy = true; $('submitDecision').disabled = true; $('refresh').disabled = true;
        notice('Saving your decision. Please wait…');
        try { render(await request({ op: 'decide', decision, reason: decision === 'decline' ? reason : '', confirmed: true })); }
        catch (error) { decisionNeedsRefresh = true; $('confirmed').checked = false; notice(`${error.message} Your decision may already have been saved; refresh the status before trying again.`, true); }
        finally { busy = false; $('submitDecision').disabled = decisionNeedsRefresh; $('refresh').disabled = false; }
    });
    $('refresh').addEventListener('click', load);
    if (['approve', 'decline'].includes(suggested)) { form.elements.decision.value = suggested; updateChoice(); }
    if (token.length < 30 || token.length > 2000) { notice('Open the secure review link in your Cerney Selects email. If you refreshed this page, reopen that original link.', true); return; }
    $('refresh').hidden = false;
    load();
})();
