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
            field(form, 'Requested coverage area (city or county)', 'area', 100, true);
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
                card.append(node('p', 'member-extra-received', requested.offer === offer.id ? 'Request received · Chris will contact you' : 'Featured upgrade request already received'));
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

    window.addEventListener('selects:member', async event => {
        const sequence = ++loadVersion;
        if (event.detail?.extrasEligible !== true) { generation++; sending = false; current = null; section.hidden = true; section.replaceChildren(); return; }
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
