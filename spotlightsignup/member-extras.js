'use strict';

(() => {
    const section = document.getElementById('memberExtras');
    if (!section) return;
    let generation = 0;
    let loadVersion = 0;
    let sending = false;
    let current = null;
    const node = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };
    const status = node('p', 'form-message');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');

    async function api(payload) {
        const response = await fetch('/api/spotlight', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Please try again.');
        return data;
    }

    function field(form, labelText, name, maxLength, required) {
        const label = node('label', 'member-extra-field', labelText);
        const input = node(name === 'notes' ? 'textarea' : 'input');
        if (name !== 'notes') input.type = 'text';
        input.name = name; input.maxLength = maxLength; input.required = required;
        if (name === 'notes') input.rows = 3;
        label.append(input); form.append(label);
    }

    function requestForm(offer, button) {
        if (sending) return;
        const oldForm = section.querySelector('.member-extra-form');
        if (oldForm) oldForm.remove();
        section.querySelectorAll('[data-request]').forEach(b => b.setAttribute('aria-expanded', 'false'));
        button.setAttribute('aria-expanded', 'true');
        const form = node('form', 'member-extra-form');
        const title = node('h4', '', `${offer.action}: ${offer.name}`);
        form.append(title);
        if (offer.specialty) {
            field(form, 'Business specialty (for example, plumber)', 'specialty', 100, true);
            form.append(node('p', 'member-extra-terms', 'Featured coverage: all Monterey County. Chris confirms the exact specialty and availability before payment.'));
        }
        field(form, offer.specialty ? 'Anything else Chris should know? (optional)' : 'Tell Chris about the video you have in mind', 'notes', 800, false);
        const label = node('label', 'member-extra-consent');
        const consent = node('input'); consent.type = 'checkbox'; consent.required = true;
        label.append(consent, node('span', '', 'This is a request only. No additional payment or exclusive position is authorized. I will review and agree to a final quote before paying.'));
        const submit = node('button', 'button button-primary', 'Send request'); submit.type = 'submit';
        const cancel = node('button', 'text-button', 'Cancel'); cancel.type = 'button';
        const message = node('p', 'form-message'); message.setAttribute('role', 'status');
        const actions = node('div', 'manage-actions'); actions.append(submit, cancel);
        form.append(label, actions, message);
        button.parentElement.append(form);
        form.querySelector('input, textarea')?.focus();
        cancel.addEventListener('click', () => { form.remove(); button.setAttribute('aria-expanded', 'false'); button.focus(); });
        let requestId = crypto.randomUUID();
        let previousPayload = '';
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!form.reportValidity() || !consent.checked || submit.disabled) return;
            const values = new FormData(form);
            const payload = { op: 'member-request', offer: offer.id, specialty: values.get('specialty') || '', area: values.get('area') || '', notes: values.get('notes') || '', consent: true };
            const fingerprint = JSON.stringify(payload);
            if (previousPayload && previousPayload !== fingerprint) requestId = crypto.randomUUID();
            previousPayload = fingerprint;
            const sequence = generation;
            sending = true;
            section.querySelectorAll('[data-request]').forEach(b => { b.disabled = true; });
            submit.disabled = true; cancel.disabled = true; message.textContent = 'Sending your request…';
            try {
                const data = await api({ ...payload, requestId });
                if (sequence !== generation) return;
                sending = false;
                render(data);
                status.textContent = 'Request received. Chris will contact you. Your confirmation email is sent or queued. No extra payment has been taken.';
                status.tabIndex = -1; status.focus();
            } catch (error) {
                if (sequence !== generation) return;
                sending = false;
                section.querySelectorAll('[data-request]').forEach(b => { b.disabled = current?.canRequest !== true; });
                message.textContent = error.name === 'TimeoutError' ? 'We are still checking your request. Refresh your status before sending another.' : error.message;
                submit.disabled = false; cancel.disabled = false;
            }
        });
    }

    function render(data) {
        current = data;
        section.replaceChildren(node('p', 'eyebrow', 'FOR MEMBERS'), node('h3', '', 'More ways to get noticed'), node('p', 'manage-description', 'Your Local Legend listing stays at $100/month. These optional services begin with a conversation and an agreed quote.'));
        if (!data.canRequest) section.append(node('p', 'member-extra-pending', 'You can request these options once your listing is approved and your membership is continuing.'));
        const grid = node('div', 'member-extras-grid');
        for (const offer of data.offers || []) {
            const card = node('article', 'member-extra-card');
            card.append(node('h4', '', offer.name), node('p', 'member-extra-price', offer.price), node('p', '', offer.detail), node('p', 'member-extra-terms', offer.terms));
            const requested = (data.requests || []).find(r => r.offer === offer.id || (offer.specialty && ['mustache', 'featured'].includes(r.offer)));
            if (requested) {
                if (requested.offer === offer.id && requested.quote) orderControls(card, requested, data);
                else card.append(node('p', 'member-extra-received', requested.offer === offer.id ? 'Request received · Chris will contact you' : 'Featured upgrade request already received'));
            } else {
                const button = node('button', 'button button-outline', offer.action);
                button.type = 'button'; button.disabled = !data.canRequest; button.dataset.request = offer.id; button.setAttribute('aria-expanded', 'false');
                button.addEventListener('click', () => requestForm(offer, button));
                card.append(button);
            }
            grid.append(card);
        }
        section.append(grid, status);
        if ((data.requests || []).length) section.append(node('p', 'manage-description', 'To update a request, reply to your confirmation email or contact cerneymedia@gmail.com. No exclusive position is reserved until the details are agreed.'));
        section.hidden = false;
    }

    function quoteTerms(order) {
        const q = order.quote;
        if (order.offer === 'spotlight') return `$${(q.amount / 100).toFixed(2)} once. Agreed scope: ${q.scope}`;
        return `$150/month extra, making $250/month total with your separate $100 listing. Featured specialty: ${q.specialty}, throughout Monterey County. ${order.offer === 'mustache' ? '$500 one-time setup. Three-month add-on minimum ($450), then monthly. Includes a one-minute video with Chris and monthly analytics. The minimum remains payable if you cancel the base listing.' : 'No setup fee. Month to month; cancel future renewals before the next billing date.'} An active base listing is required to display the feature. The two subscriptions can have different renewal dates.`;
    }
    function date(value) { return value ? new Date(value * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''; }
    function orderControls(card, order, data) {
        if (order.quote?.status === 'declined') { card.append(node('p', '', 'Chris cannot offer this request right now. Reply to your email to discuss alternatives.')); return; }
        card.append(node('p', 'member-extra-terms', quoteTerms(order)));
        const billing = order.billing;
        if (billing && ['active', 'paid', 'payment_review', 'canceled', 'processing'].includes(billing.state)) {
            const labels = { active: 'Payment confirmed · service active', paid: 'Payment confirmed · Chris will coordinate your video', payment_review: 'Payment needs attention · contact Chris', canceled: 'Service canceled', processing: 'Payment is processing · do not pay again' };
            card.append(node('p', 'member-extra-received', labels[billing.state]));
            if (billing.minimumEnd) card.append(node('p', '', `Minimum term ends ${date(billing.minimumEnd)}.`));
            if (billing.cancelAt) card.append(node('p', '', `Renewals stop ${date(billing.cancelAt)}.`));
            else if (billing.cancellationRequested) card.append(node('p', '', 'Cancellation recorded. Stripe is confirming the end date.'));
            else if (billing.periodEnd) card.append(node('p', '', `Current add-on period ends ${date(billing.periodEnd)}.`));
            if (order.offer !== 'spotlight' && ['active', 'payment_review'].includes(billing.state) && !billing.cancellationRequested && !billing.cancelAt) {
                const form = node('form', 'member-extra-form');
                const label = node('label', 'member-extra-consent'), consent = node('input'); consent.type = 'checkbox'; consent.required = true;
                label.append(consent, node('span', '', 'Stop this add-on’s future renewals at the end of my paid period or applicable minimum term. My base listing stays separate.'));
                const button = node('button', 'button button-outline', 'Cancel add-on renewal'); button.type = 'submit';
                const message = node('p', 'form-message'); message.setAttribute('role', 'status'); form.append(label, button, message); card.append(form);
                form.addEventListener('submit', async event => { event.preventDefault(); if (!consent.checked || button.disabled) return; button.disabled = true; const sequence = generation;
                    try { const updated = await api({ op: 'member-cancel', requestId: order.id, confirmed: true }); if (sequence !== generation) return; card.replaceChildren(node('h4', '', 'Member service')); orderControls(card, updated, data); }
                    catch (error) { if (sequence !== generation) return; message.textContent = error.message; button.disabled = false; }
                });
            }
            return;
        }
        if (order.quote.expiresAt <= Date.now() || billing?.state === 'expired') { card.append(node('p', '', 'This quote or checkout expired. Reply to your quote email for a fresh offer.')); return; }
        if (!data.purchasesEnabled || !data.canRequest) { card.append(node('p', '', 'Your quote is saved. Checkout will be available once your membership and the payment setup are ready.')); return; }
        const form = node('form', 'member-extra-form'), label = node('label', 'member-extra-consent'), consent = node('input'); consent.type = 'checkbox'; consent.required = true;
        label.append(consent, node('span', '', 'I agree to this quote, the displayed charges, renewal and cancellation terms, and the agreed service scope.'));
        const pay = node('button', 'button button-primary', billing ? 'Continue secure checkout' : 'Review and pay with Stripe'); pay.type = 'submit';
        const message = node('p', 'form-message'); message.setAttribute('role', 'status'); form.append(label, pay, message); card.append(form);
        form.addEventListener('submit', async event => { event.preventDefault(); if (!consent.checked || pay.disabled) return; pay.disabled = true; message.textContent = 'Opening secure checkout…'; const sequence = generation;
            api({ op: 'member-checkout', requestId: order.id, version: order.quote.version, consent: true }).then(result => {
                if (sequence !== generation) return;
                const url = new URL(result.url); if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') throw new Error('Checkout needs review.'); window.location.assign(url.href);
            }).catch(error => { if (sequence !== generation) return; message.textContent = error.message; pay.disabled = false; });
        });
    }

    function renderOrders(data) {
        section.replaceChildren(node('h3', '', 'Your member services'));
        for (const order of data.orders || []) { const card = node('article', 'member-extra-card'); card.append(node('h4', '', order.offer === 'spotlight' ? 'The Cerney Spotlight' : order.offer === 'mustache' ? 'The Mustache Stamp' : 'Featured specialty')); orderControls(card, order, { canRequest: false, purchasesEnabled: false }); section.append(card); }
        section.hidden = !(data.orders || []).length;
    }

    window.addEventListener('selects:member', async event => {
        const sequence = ++loadVersion;
        if (event.detail?.extrasEligible !== true) {
            generation++; sending = false; current = null; section.hidden = true; section.replaceChildren();
            if (event.detail?.extrasManageAvailable) try { const data = await api({ op: 'member-orders' }); if (sequence === loadVersion) renderOrders(data); } catch { /* No private offers or stale purchase state on failure. */ }
            return;
        }
        try {
            const data = await api({ op: 'member-options' });
            if (sequence !== loadVersion) return;
            // Keep an unsent draft while the user's membership remains eligible.
            if (current && section.querySelector('form') && data.canRequest) return;
            render(data);
        } catch {
            if (sequence !== loadVersion) return;
            generation++; sending = false; current = null; section.hidden = true; section.replaceChildren();
        }
    });
})();
