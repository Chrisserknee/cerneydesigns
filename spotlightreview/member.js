'use strict';
(() => {
    const token = window.location.hash.slice(1);
    history.replaceState(null, '', location.pathname);
    const message = document.getElementById('reviewMessage'), form = document.getElementById('quoteForm'), details = document.getElementById('requestDetails');
    let current;
    let decisionId = crypto.randomUUID(), previousDecision = '';
    const node = (tag, text) => { const el = document.createElement(tag); el.textContent = text; return el; };
    async function api(op, payload = {}) {
        const response = await fetch('/api/spotlight-review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ op, token, ...payload }), signal: AbortSignal.timeout(30000) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Please try again.'); return result;
    }
    async function load() {
        if (!token) { message.textContent = 'Open the private review link from the member request email.'; return; }
        try {
            current = await api('member-review');
            const names = { featured: 'Featured specialty · $150/month extra · month to month', mustache: 'The Mustache Stamp · $150/month extra + $500 setup · three-month minimum', spotlight: 'The Cerney Spotlight · quote from $1,000 once' };
            details.replaceChildren(node('h2', current.businessName), node('p', names[current.offer]), node('p', `Requested specialty: ${current.specialty || 'Not applicable'}`), node('p', current.notes || 'No additional notes.'));
            details.hidden = false;
            const spotlight = current.offer === 'spotlight';
            document.getElementById('specialtyField').hidden = spotlight; document.getElementById('specialtyHelp').hidden = spotlight;
            document.getElementById('amountField').hidden = !spotlight;
            form.elements.specialty.required = !spotlight; form.elements.amount.required = spotlight; form.elements.scope.required = spotlight;
            form.elements.specialty.value = current.quote?.specialty || current.specialty || '';
            form.elements.amount.value = current.quote?.amount ? (current.quote.amount / 100).toFixed(2) : '1000.00';
            form.elements.scope.value = current.quote?.scope || '';
            form.hidden = !!current.billing && !['expired', 'canceled'].includes(current.billing.state);
            message.textContent = form.hidden ? 'This request already has a payment or service. Its quote is locked.' : current.purchasesEnabled ? 'Confirm the agreed details before emailing the quote.' : 'Quotes can be prepared. Member checkout is not enabled yet.';
            const occupied = document.getElementById('occupiedSpecialties');
            occupied.replaceChildren(node('h2', 'Reserved or active specialties'));
            const list = node('ul', '');
            for (const slot of current.occupied || []) { list.append(node('li', `${slot.specialty} — ${slot.state}`)); const option = document.createElement('option'); option.value = slot.specialty; document.getElementById('specialties').append(option); }
            if (!list.children.length) list.append(node('li', 'None yet.'));
            occupied.append(list); occupied.hidden = spotlight;
        } catch (error) { message.textContent = error.message; }
    }
    async function submit(decision) {
        if (!form.elements.confirmed.checked || (decision === 'approve' && !form.reportValidity())) { message.textContent = 'Confirm the review details first.'; return; }
        form.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
            const payload = { decision, confirmed: true, specialty: form.elements.specialty.value, scope: form.elements.scope.value, amount: Math.round(Number(form.elements.amount.value) * 100) };
            const fingerprint = JSON.stringify(payload);
            if (previousDecision && previousDecision !== fingerprint) decisionId = crypto.randomUUID();
            previousDecision = fingerprint;
            await api('member-quote', { ...payload, decisionId });
            form.hidden = true; message.textContent = decision === 'approve' ? 'Quote saved. The member email is queued. No payment has been taken.' : 'Request declined. The member email is queued. No payment has been taken.';
        } catch (error) { message.textContent = error.message; form.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
    }
    form.addEventListener('submit', event => { event.preventDefault(); submit('approve'); });
    document.getElementById('declineQuote').addEventListener('click', () => submit('decline'));
    load();
})();
