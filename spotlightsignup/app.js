'use strict';

(() => {
    const API = '/api/spotlight';
    const DRAFT_KEY = 'cc_spotlight_draft_v1';
    const REQUEST_KEY = 'cc_spotlight_request_v1';
    const PUBLIC_FIELDS = ['businessName', 'category', 'city', 'description', 'website', 'phone', 'logoUrl', ...window.CerneySelectsSocials.platforms.map(item => item.field)];
    const categories = [
        'Food & Restaurants',
        'Drinks & Nightlife',
        'Home & Property',
        'Shopping & Local Makers',
        'Health & Wellness',
        'Family & Community',
        'Experiences & Entertainment',
        'Professional Services',
        'Auto & Transportation',
        'Farms, Outdoors & Local Living',
    ];
    const byId = (id) => document.getElementById(id);
    const signupForm = byId('signupForm');
    const manageForm = byId('manageForm');
    const previewDetails = byId('listingPreviewDetails');
    if (previewDetails) {
        const widePreview = window.matchMedia('(min-width: 801px)');
        previewDetails.open = widePreview.matches;
        widePreview.addEventListener?.('change', () => { previewDetails.open = widePreview.matches; });
    }
    // Optional inputs remain reachable when native validation finds an invalid value.
    for (const form of [signupForm, manageForm]) {
        form.addEventListener('invalid', (event) => {
            const details = event.target.closest('details');
            if (details) details.open = true;
        }, true);
    }

    let checkoutEnabled = false;
    let submitting = false;
    let ownerState = null;
    let checkingStatus = false;
    let statusRequest = null;
    let forgetting = false;
    let statusAttempts = 0;
    let pollTimer = null;
    let checkoutReturn = new URLSearchParams(window.location.search).get('checkout');
    let confirmationAnnounced = false;
    const LOGO_FILE_LIMIT = 2 * 1024 * 1024;
    const LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const logoUpload = { file: null, previewUrl: '', phase: 'idle', generation: 0 };

    function stored(key) {
        try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
    }

    function saveStored(key, value) {
        try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* The form still works without storage. */ }
    }

    function removeStored(key) {
        try { sessionStorage.removeItem(key); } catch { /* Storage is optional. */ }
    }

    function string(value, max = 400) {
        return typeof value === 'string' ? value.trim().slice(0, max) : '';
    }

    function websiteUrl(value) {
        try {
            const url = new URL(string(value, 500));
            if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password || url.port || url.hostname === 'localhost' || url.hostname.endsWith('.local') || /^[\d.]+$/.test(url.hostname)) return '';
            return url.href;
        } catch { return ''; }
    }

    function stripeUrl(value, kind) {
        try {
            const url = new URL(value);
            const host = kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
            return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password ? url.href : '';
        } catch { return ''; }
    }

    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function publicProfile(profile) {
        const source = profile && typeof profile === 'object' ? profile : {};
        return Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, string(source[field], field === 'description' ? 400 : field === 'logoUrl' ? 500 : (field === 'website' || field.endsWith('Url')) ? 300 : field === 'phone' ? 40 : field === 'city' ? 80 : 100)]));
    }

    function businessCard(profile, preview = false, localLogoPreview = '') {
        const safe = publicProfile(profile);
        const name = safe.businessName || (preview ? 'Your business name' : 'Local business');
        const initials = name.split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0] || '').join('').toUpperCase();
        const card = node('article', 'business-card');
        const top = node('div', 'card-top');
        const mark = node('span', 'business-mark', safe.businessName ? initials : 'CC');
        mark.setAttribute('aria-hidden', 'true');
        const logo = preview && localLogoPreview ? localLogoPreview : websiteUrl(safe.logoUrl);
        if (logo) {
            const img = node('img', 'business-logo');
            img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = logo;
            img.addEventListener('error', () => mark.replaceChildren(document.createTextNode(initials || 'CC')), { once: true });
            mark.replaceChildren(img);
        }
        top.append(mark, node('span', 'advertising-tag', 'Paid listing'));
        card.append(top);
        card.append(node('p', 'business-category', safe.category || 'Your category'));
        card.append(node('h3', '', name));
        card.append(node('p', 'business-location', safe.city || 'Your community'));
        card.append(node('p', 'business-description', safe.description || 'A little about your business, what you offer, and what makes you part of this community.'));
        const links = node('div', 'card-links');
        const href = websiteUrl(safe.website);
        if (href && !preview) {
            const website = node('a', '', 'Visit website ↗');
            website.href = href;
            website.target = '_blank';
            website.rel = 'sponsored noopener noreferrer';
            website.setAttribute('aria-label', `Visit ${name} website (opens in a new tab)`);
            links.append(website);
        } else if (preview) {
            links.append(node('span', 'card-link-preview', 'Visit website ↗'));
        }
        if (safe.phone) {
            const contact = window.CerneySelectsPhone(safe.phone);
            const phone = node(contact.href && !preview ? 'a' : 'span', 'card-phone');
            if (contact.href) {
                if (!preview) {
                    phone.href = contact.href;
                    phone.setAttribute('aria-label', `Call ${name} at ${contact.display}`);
                }
                phone.append(node('span', 'contact-phone-label', 'Call'));
            }
            phone.append(node('span', 'contact-phone-number', contact.display));
            links.append(phone);
        }
        const socials = window.CerneySelectsSocialLinks(safe, { preview });
        if (socials) links.append(socials);
        card.append(links);
        return card;
    }

    function readForm(form, includeEmail = false) {
        const data = new FormData(form);
        const profile = Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, string(data.get(field), field === 'description' ? 400 : field === 'logoUrl' ? 500 : 300)]));
        if (includeEmail) profile.email = string(data.get('email'), 254);
        return profile;
    }

    function fillForm(form, profile) {
        if (!profile || typeof profile !== 'object') return;
        [...PUBLIC_FIELDS, 'email'].forEach((field) => {
            const input = form.elements.namedItem(field);
            if (input && typeof profile[field] === 'string') input.value = profile[field].slice(0, input.maxLength > 0 ? input.maxLength : 100);
        });
    }

    function updatePreview() {
        const profile = readForm(signupForm, true);
        byId('descriptionCount').textContent = `${profile.description.length} / 400`;
        byId('profilePreview').replaceChildren(businessCard(profile, true, logoUpload.previewUrl));
        saveStored(DRAFT_KEY, profile);
    }

    function message(id, text, success = false) {
        byId(id).textContent = text;
        byId(id).classList.toggle('success', success);
    }

    async function request(body, endpoint = API) {
        const controller = new AbortController();
        const timeoutMs = endpoint === '/api/spotlight-logo' ? 45000 : 25000;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(endpoint, {
                method: body ? 'POST' : 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: controller.signal,
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data || typeof data !== 'object') {
                throw new Error(string(data?.error, 240) || 'Cerney Selects is temporarily unavailable. Please try again.');
            }
            return data;
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('This is taking longer than expected. Please try again.');
            if (error instanceof TypeError) throw new Error('Unable to connect. Check your connection and try again.');
            throw error;
        } finally { clearTimeout(timer); }
    }

    function refreshCheckout() {
        const hasSubscription = ownerState && ['active', 'past_due'].includes(ownerState.status);
        ['logoFile', 'removeLogo', 'retryLogoUpload'].forEach((id) => { byId(id).disabled = submitting || forgetting; });
        byId('logoUrl').readOnly = submitting || forgetting;
        byId('checkoutButton').disabled = !checkoutEnabled || submitting || forgetting || logoUploadBlocked() || !byId('forgetConfirm').hidden || Boolean(hasSubscription);
        if (hasSubscription) {
            byId('checkoutNotice').textContent = 'You already have a subscription on this device. Check your review status and manage billing below.';
            byId('checkoutNotice').classList.add('ready-notice');
        } else if (checkoutEnabled) {
            byId('checkoutNotice').textContent = '';
            byId('checkoutNotice').classList.add('ready-notice');
        } else {
            byId('checkoutNotice').textContent = 'Online signup is being set up. You can preview your listing below. Need help? Email cerneymedia@gmail.com.';
            byId('checkoutNotice').classList.remove('ready-notice');
        }
    }

    function logoUploadBlocked() {
        return ['uploading', 'failed'].includes(logoUpload.phase);
    }

    function releaseLogoPreview() {
        if (logoUpload.previewUrl) URL.revokeObjectURL(logoUpload.previewUrl);
        logoUpload.previewUrl = '';
    }

    function refreshLogoControls(text = '') {
        byId('logoUploadStatus').textContent = text;
        byId('logoUploadStatus').classList.toggle('upload-error', logoUpload.phase === 'failed');
        byId('logoUploadStatus').classList.toggle('upload-success', logoUpload.phase === 'uploaded');
        byId('retryLogoUpload').hidden = logoUpload.phase !== 'failed' || !logoUpload.file;
        byId('removeLogo').hidden = logoUpload.phase === 'idle' && !byId('logoUrl').value.trim();
        byId('logoFile').setAttribute('aria-invalid', String(logoUpload.phase === 'failed'));
        refreshCheckout();
    }

    function resetLogoUpload({ clearUrl = false, text = '' } = {}) {
        logoUpload.generation += 1;
        releaseLogoPreview();
        logoUpload.file = null;
        logoUpload.phase = 'idle';
        byId('logoFile').value = '';
        if (clearUrl) byId('logoUrl').value = '';
        byId('logoUrl').setCustomValidity('');
        refreshLogoControls(text);
        updatePreview();
    }

    async function uploadLogo(file) {
        const generation = ++logoUpload.generation;
        releaseLogoPreview();
        logoUpload.file = null;
        logoUpload.phase = 'uploading';
        byId('logoUrl').value = '';
        byId('logoUrl').setCustomValidity('');
        // Clear any previous URL immediately, including from the saved draft.
        updatePreview();
        if (!LOGO_TYPES.includes(file.type) || file.size < 1 || file.size > LOGO_FILE_LIMIT) {
            logoUpload.phase = 'failed';
            refreshLogoControls(file.size > LOGO_FILE_LIMIT ? 'That image is too large. Choose a JPG, PNG, or WebP up to 2 MB, paste an image link, or remove the logo to continue.' : 'Choose a JPG, PNG, or WebP image, paste an image link, or remove the logo to continue.');
            return;
        }
        logoUpload.file = file;
        logoUpload.previewUrl = URL.createObjectURL(file);
        updatePreview();
        refreshLogoControls(`Uploading ${string(file.name, 160) || 'your logo'}… Please wait before continuing to payment.`);
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (generation !== logoUpload.generation) return;
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
            const result = await request({ imageBase64: btoa(binary), mimeType: file.type }, '/api/spotlight-logo');
            if (generation !== logoUpload.generation) return;
            const url = typeof result.logoUrl === 'string' && result.logoUrl.trim().length <= 500 ? websiteUrl(result.logoUrl) : '';
            if (!url) throw new Error('We couldn’t save that logo. Please try again.');
            byId('logoUrl').value = url;
            releaseLogoPreview();
            logoUpload.phase = 'uploaded';
            updatePreview();
            refreshLogoControls('Logo uploaded and ready. It will appear with your listing if your application is approved.');
        } catch (error) {
            if (generation !== logoUpload.generation) return;
            logoUpload.phase = 'failed';
            refreshLogoControls(`${string(error.message, 240) || 'We couldn’t upload your logo.'} Try again, paste an image link, or remove the logo to continue.`);
        }
    }

    byId('logoFile').addEventListener('change', () => {
        const file = byId('logoFile').files?.[0];
        if (file) uploadLogo(file);
    });
    byId('retryLogoUpload').addEventListener('click', () => {
        if (logoUpload.file && logoUpload.phase === 'failed') uploadLogo(logoUpload.file);
    });
    byId('removeLogo').addEventListener('click', () => {
        resetLogoUpload({ clearUrl: true, text: 'Logo removed. We’ll use your business initials.' });
        byId('logoFile').focus();
    });

    async function loadConfiguration() {
        try {
            const data = await request();
            const priceMatches = data.price?.amount === 10000 && data.price?.currency === 'usd' && data.price?.interval === 'month';
            checkoutEnabled = data.checkoutEnabled === true && priceMatches;
            const portalLogin = stripeUrl(data.portalLoginUrl, 'portal');
            byId('portalLogin').hidden = !portalLogin;
            if (portalLogin) byId('portalLogin').href = portalLogin;
        } catch {
            checkoutEnabled = false;
        } finally {
            refreshCheckout();
        }
    }

    function periodDate(value) {
        if (!value) return '';
        const date = new Date(typeof value === 'number' ? value * 1000 : value);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(date);
    }

    function renderPaymentConfirmation(data) {
        const confirmed = checkoutReturn === 'success' && data.status === 'active' && data.paymentConfirmed === true && data.published !== true && ['pending', 'approving'].includes(data.reviewStatus);
        byId('paymentConfirmation').hidden = !confirmed;
        byId('signupHeading').hidden = confirmed;
        byId('reviewPolicy').hidden = confirmed;
        byId('signupLayout').hidden = confirmed;
        if (!confirmed) return;
        const name = string(data.profile?.businessName, 100);
        byId('confirmationBusiness').textContent = name ? `Application for ${name}` : '';
        byId('confirmationBusiness').hidden = !name;
        if (!confirmationAnnounced) {
            confirmationAnnounced = true;
            byId('paymentConfirmation').focus({ preventScroll: true });
            byId('paymentConfirmation').scrollIntoView({ block: 'start', behavior: 'instant' });
        }
    }

    function renderOwner(data, updateFields = true) {
        ownerState = data;
        window.dispatchEvent(new CustomEvent('selects:member', { detail: data }));
        const active = data.status === 'active';
        const published = data.published === true;
        const hidden = data.hidden === true;
        const until = periodDate(data.currentPeriodEnd);
        const reviewPending = ['pending', 'approving'].includes(data.reviewStatus);
        const reviewDeclining = ['declining', 'declined'].includes(data.reviewStatus);
        let label = 'No subscription';
        let description = 'No subscription is linked to this browser. On another device? Sign in to billing with your subscription email. Contact Chris for listing changes.';
        if (data.status === 'pending' || (active && reviewPending && data.paymentConfirmed !== true)) {
            label = 'Awaiting payment';
            description = 'Your listing is saved, and payment has not been confirmed yet. If you finished checkout, refresh your status in a moment.';
        } else if (reviewDeclining) {
            label = data.refundStatus === 'succeeded' ? 'Declined · refunded' : 'Declined · refund processing';
            description = `Your application was declined. ${data.declineReason || 'Your review decision will arrive by email.'} ${data.refundStatus === 'succeeded' ? 'Your full $100 refund has been issued. Your bank may take additional time to show it.' : 'Your listing stays hidden while we complete cancellation and your full $100 refund. We will email you when it has been issued.'}`;
        } else if (data.reviewStatus === 'needs_attention') {
            label = 'Review needs attention';
            description = 'Your listing is not published. Chris is checking your application and payment. Contact us if you need an update.';
        } else if (active && reviewPending) {
            label = data.reviewStatus === 'approving' ? 'Approval processing' : 'Awaiting approval';
            description = 'Payment received. Your listing stays private while we review it, within 2 days. We will email the decision. No further monthly payment is collected while review is pending.';
        } else if (active && data.cancelAtPeriodEnd) {
            label = 'Cancellation scheduled';
            description = `Your subscription will not renew. ${published ? 'Your listing remains visible' : 'Your paid period continues'}${until ? ` through ${until}` : ' through the end of your paid billing period'}.`;
        } else if (active) {
            label = published ? 'Active' : hidden ? 'Hidden' : 'Not published';
            description = published ? 'Your business is in the spotlight. Manage your monthly subscription through Stripe. Contact Chris to request listing changes.' : hidden ? 'Your listing is currently hidden from the directory. Contact Chris for help. Your billing account is still available below.' : 'Your listing is not published yet. Refresh your status in a moment, or contact Chris if you need help.';
        } else if (data.status === 'past_due') {
            label = 'Payment needed';
            description = 'Your latest payment needs attention. Open Manage billing to update your payment method. Your listing may be hidden until payment is confirmed.';
        } else if (data.status === 'canceled' || data.status === 'expired') {
            label = data.status === 'canceled' ? 'Canceled' : 'Expired';
            description = 'This subscription has ended and your listing is no longer featured. You can create a new subscription using the form above.';
            removeStored(REQUEST_KEY);
        }
        byId('manageStatus').textContent = label;
        byId('manageMessage').textContent = description;
        byId('portalButton').hidden = data.canManage !== true;
        byId('forgetDevice').hidden = !data.status || data.status === 'none';
        byId('editDetails').hidden = data.canEdit !== true || !data.profile;
        if (data.profile && updateFields) {
            fillForm(manageForm, data.profile);
            updateManageCount();
        }
        refreshCheckout();
        renderPaymentConfirmation(data);
        if (checkoutReturn === 'success') {
            const notice = byId('returnNotice');
            notice.hidden = false;
            notice.classList.remove('ready-notice');
            if (active && published) {
                notice.textContent = 'Payment confirmed. Your business is now in Cerney Selects. You can manage your listing below.';
                notice.classList.add('ready-notice');
                removeStored(DRAFT_KEY);
                removeStored(REQUEST_KEY);
                clearTimeout(pollTimer);
            } else if (reviewDeclining || data.reviewStatus === 'needs_attention') {
                notice.textContent = description;
                clearTimeout(pollTimer);
            } else if (active && reviewPending && data.paymentConfirmed === true) {
                notice.textContent = 'Payment received. Your application is awaiting review. Allow up to 2 days; we’ll email you when it is approved or declined. Your business is not public yet.';
                notice.classList.add('ready-notice');
                removeStored(DRAFT_KEY); removeStored(REQUEST_KEY);
                clearTimeout(pollTimer);
            } else if (hidden) {
                notice.textContent = 'Your listing is currently hidden from the directory. Contact Chris for help with your listing.';
            } else if (active) {
                notice.textContent = 'Your listing is not published yet. We’re checking for payment confirmation. If this continues, contact Chris for help.';
            } else if (data.status === 'past_due') {
                notice.textContent = 'Your payment needs attention. Open Manage billing below to check your subscription.';
            } else if (data.status === 'canceled') {
                notice.textContent = 'This subscription has ended. Your listing is no longer featured. You can start a new subscription using the form above.';
            } else if (data.status === 'expired') {
                notice.textContent = 'This checkout expired without an active subscription. You can restart using the form above.';
            } else if (data.status === 'none') {
                notice.textContent = 'No subscription is linked to this browser. Use billing email sign-in below to check an existing purchase, or contact Chris for help.';
            } else {
                notice.textContent = 'Thanks for returning. We’re waiting for payment confirmation before reviewing your application. This may take a little time.';
            }
        }
    }

    async function loadStatus({ poll = false, updateFields = true } = {}) {
        if (checkingStatus || forgetting) return;
        checkingStatus = true;
        byId('refreshStatus').disabled = true;
        try {
            statusRequest = request({ op: 'status' });
            const data = await statusRequest;
            if (forgetting) return;
            renderOwner(data, updateFields);
            const stillWaiting = !data.hidden && (data.status === 'pending' || (data.status === 'active' && data.paymentConfirmed !== true && data.reviewStatus === 'pending'));
            if (!stillWaiting) clearTimeout(pollTimer);
            if (poll && stillWaiting && statusAttempts < 12) {
                statusAttempts += 1;
                pollTimer = setTimeout(() => loadStatus({ poll: true, updateFields: !byId('editDetails').open }), 5000);
            } else if (poll && stillWaiting && statusAttempts >= 12) {
                byId('returnNotice').textContent = 'Payment confirmation is still pending. After payment is confirmed, we review your application within 2 days. Only approved listings appear. You can refresh your status below or return later.';
            }
        } catch {
            if (forgetting) return;
            window.dispatchEvent(new CustomEvent('selects:member', { detail: {} }));
            byId('manageStatus').textContent = 'Unavailable';
            byId('manageMessage').textContent = 'We couldn’t check your subscription. Try refreshing your status, or contact Chris if you need help.';
            if (checkoutReturn === 'success') {
                byId('returnNotice').hidden = false;
                byId('returnNotice').textContent = 'We couldn’t confirm your payment status yet. Please refresh your status below before starting another checkout.';
            }
        } finally {
            statusRequest = null;
            checkingStatus = false;
            byId('refreshStatus').disabled = forgetting;
        }
    }

    function uuid() {
        if (crypto.randomUUID) return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    function checkoutRequestId(profile) {
        const fingerprint = JSON.stringify(profile);
        const saved = stored(REQUEST_KEY);
        if (saved?.fingerprint === fingerprint && typeof saved.id === 'string') return saved.id;
        const id = uuid();
        saveStored(REQUEST_KEY, { fingerprint, id });
        return id;
    }

    function validateProfile(form) {
        const website = form.elements.namedItem('website');
        website.setCustomValidity(websiteUrl(website.value) ? '' : 'Enter a valid website beginning with https://.');
        const logo = form.elements.namedItem('logoUrl');
        logo.setCustomValidity(!logo.value.trim() || websiteUrl(logo.value) ? '' : 'Enter a direct HTTPS image link.');
        const category = form.elements.namedItem('category');
        category.setCustomValidity(categories.includes(category.value) ? '' : 'Choose a category.');
        for (const { field, name } of window.CerneySelectsSocials.platforms) {
            const input = form.elements.namedItem(field);
            try { window.CerneySelectsSocials.normalize(field, input.value); input.setCustomValidity(''); }
            catch { input.setCustomValidity(`Enter a valid ${name} profile link or @username, or leave it blank.`); }
        }
        return form.reportValidity();
    }

    signupForm.addEventListener('input', (event) => {
        if (['website', 'logoUrl', ...window.CerneySelectsSocials.platforms.map(item => item.field)].includes(event.target.name)) event.target.setCustomValidity('');
        if (event.target.name === 'logoUrl') resetLogoUpload({ text: event.target.value.trim() ? 'Image link selected. Check the listing preview before continuing.' : '' });
        else updatePreview();
    });
    signupForm.addEventListener('change', updatePreview);
    signupForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submitting || forgetting || logoUploadBlocked() || !byId('forgetConfirm').hidden || !checkoutEnabled || !validateProfile(signupForm) || !byId('consent').checked) return;
        if (ownerState && ['active', 'past_due'].includes(ownerState.status)) return;
        const profile = readForm(signupForm, true);
        submitting = true;
        refreshCheckout();
        message('signupMessage', 'Opening secure checkout…', true);
        try {
            const data = await request({ op: 'checkout', profile, requestId: checkoutRequestId(profile), consent: true });
            const url = stripeUrl(data.url, 'checkout');
            if (!url) throw new Error('We couldn’t open secure checkout. Please try again.');
            window.location.assign(url);
        } catch (error) {
            message('signupMessage', error.message);
            submitting = false;
            refreshCheckout();
        }
    });

    // Reuse the public fields for editing, with distinct IDs and label associations.
    const manageFields = byId('profileFields').cloneNode(true);
    manageFields.id = 'manageProfileFields';
    manageFields.querySelectorAll('[data-signup-only]').forEach((element) => element.remove());
    manageFields.querySelectorAll('[id]').forEach((element) => { element.id = `manage-${element.id}`; });
    manageFields.querySelectorAll('[for]').forEach((element) => { element.htmlFor = `manage-${element.htmlFor}`; });
    manageFields.querySelectorAll('[aria-describedby]').forEach((element) => {
        element.setAttribute('aria-describedby', element.getAttribute('aria-describedby').split(' ').map((id) => `manage-${id}`).join(' '));
    });
    byId('manageFields').append(manageFields);
    function updateManageCount() {
        byId('manage-descriptionCount').textContent = `${manageForm.elements.namedItem('description').value.trim().length} / 400`;
    }
    manageForm.addEventListener('input', (event) => {
        if (['website', 'logoUrl', ...window.CerneySelectsSocials.platforms.map(item => item.field)].includes(event.target.name)) event.target.setCustomValidity('');
        updateManageCount();
    });
    manageForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (forgetting || !byId('forgetConfirm').hidden || !validateProfile(manageForm)) return;
        byId('saveProfile').disabled = true;
        byId('forgetDevice').disabled = true;
        message('manageFormMessage', 'Saving your changes…', true);
        try {
            const data = await request({ op: 'update', profile: readForm(manageForm) });
            renderOwner(data);
            message('manageFormMessage', 'Your business details have been saved.', true);
        } catch (error) {
            message('manageFormMessage', error.message);
        } finally { byId('saveProfile').disabled = false; byId('forgetDevice').disabled = false; }
    });

    byId('portalButton').addEventListener('click', async () => {
        if (forgetting || !byId('forgetConfirm').hidden) return;
        byId('portalButton').disabled = true;
        byId('forgetDevice').disabled = true;
        try {
            const data = await request({ op: 'portal' });
            const url = stripeUrl(data.url, 'portal');
            if (!url) throw new Error('We couldn’t open billing. Please try again.');
            window.location.assign(url);
        } catch (error) {
            byId('manageMessage').textContent = error.message;
            byId('portalButton').disabled = false;
            byId('forgetDevice').disabled = false;
        }
    });
    byId('forgetDevice').addEventListener('click', () => {
        byId('forgetConfirm').hidden = false;
        byId('forgetDevice').setAttribute('aria-expanded', 'true');
        byId('portalButton').disabled = true;
        byId('saveProfile').disabled = true;
        refreshCheckout();
        byId('cancelForget').focus();
    });
    byId('cancelForget').addEventListener('click', () => {
        byId('forgetConfirm').hidden = true;
        byId('forgetDevice').setAttribute('aria-expanded', 'false');
        byId('portalButton').disabled = false;
        byId('saveProfile').disabled = false;
        message('forgetMessage', '');
        refreshCheckout();
        byId('forgetDevice').focus();
    });
    byId('confirmForget').addEventListener('click', async () => {
        if (forgetting) return;
        forgetting = true;
        clearTimeout(pollTimer);
        pollTimer = null;
        ['confirmForget', 'cancelForget', 'forgetDevice', 'portalButton', 'refreshStatus', 'saveProfile'].forEach((id) => { byId(id).disabled = true; });
        refreshCheckout();
        message('forgetMessage', 'Forgetting this device…', true);
        try {
            // Status refreshes renew the owner cookie. Finish any pending refresh
            // before logout so its response cannot restore access after sign-out.
            if (statusRequest) await statusRequest.catch(() => {});
            const data = await request({ op: 'logout' });
            if (data.status !== 'none') throw new Error('We couldn’t forget this device. Please try again.');
            checkoutReturn = null;
            confirmationAnnounced = false;
            statusAttempts = 0;
            signupForm.reset();
            resetLogoUpload({ clearUrl: true });
            manageForm.reset();
            updatePreview();
            removeStored(DRAFT_KEY);
            removeStored(REQUEST_KEY);
            byId('editDetails').open = false;
            byId('forgetConfirm').hidden = true;
            byId('forgetDevice').setAttribute('aria-expanded', 'false');
            byId('returnNotice').hidden = true;
            byId('returnNotice').textContent = '';
            message('signupMessage', '');
            message('manageFormMessage', '');
            message('forgetMessage', '');
            renderOwner(data);
            byId('manageMessage').textContent = 'This device has been forgotten. Your subscription and billing continue. Sign in to billing by email, or contact Chris for listing changes.';
        } catch (error) {
            message('forgetMessage', error.message);
        } finally {
            forgetting = false;
            ['confirmForget', 'cancelForget', 'forgetDevice', 'portalButton', 'refreshStatus', 'saveProfile'].forEach((id) => { byId(id).disabled = false; });
            refreshCheckout();
            if (byId('forgetConfirm').hidden) byId('refreshStatus').focus();
        }
    });
    byId('refreshStatus').addEventListener('click', () => loadStatus({ updateFields: !byId('editDetails').open }));
    byId('menuToggle').addEventListener('click', () => {
        const open = byId('menuToggle').getAttribute('aria-expanded') !== 'true';
        byId('menuToggle').setAttribute('aria-expanded', String(open));
        byId('primaryLinks').classList.toggle('is-open', open);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && byId('primaryLinks').classList.contains('is-open')) {
            byId('menuToggle').setAttribute('aria-expanded', 'false');
            byId('primaryLinks').classList.remove('is-open');
            byId('menuToggle').focus();
        }
    });
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            submitting = false;
            byId('portalButton').disabled = false;
            byId('forgetDevice').disabled = false;
            loadConfiguration();
            loadStatus();
        }
    });

    fillForm(signupForm, stored(DRAFT_KEY));
    refreshLogoControls();
    updatePreview();
    if (checkoutReturn === 'canceled') {
        byId('returnNotice').hidden = false;
        byId('returnNotice').textContent = 'You returned from checkout. Your draft is saved on this device, and you can continue when you’re ready. If you completed a payment, check your subscription status below.';
    } else if (checkoutReturn === 'success') {
        byId('returnNotice').hidden = false;
        byId('returnNotice').textContent = 'Checking your payment. After payment is confirmed, we review your application within 2 days. Only approved listings appear.';
    }
    if (checkoutReturn) {
        byId('returnNotice').focus({ preventScroll: true });
        byId('returnNotice').scrollIntoView({ block: 'center', behavior: 'instant' });
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('checkout');
        history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    }
    loadConfiguration();
    loadStatus({ poll: checkoutReturn === 'success' });
})();
