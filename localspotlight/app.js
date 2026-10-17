'use strict';

(() => {
    const API = '/api/spotlight';
    const PUBLIC_FIELDS = ['businessName', 'category', 'city', 'description', 'website', 'phone'];
    const byId = (id) => document.getElementById(id);
    let listings = [];
    let directoryLoaded = false;

    function string(value, max = 400) {
        return typeof value === 'string' ? value.trim().slice(0, max) : '';
    }

    function websiteUrl(value) {
        try {
            const url = new URL(string(value, 300));
            if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password || url.port || url.hostname === 'localhost' || url.hostname.endsWith('.local') || /^[\d.]+$/.test(url.hostname)) return '';
            return url.href;
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
        return Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, string(source[field], field === 'description' ? 400 : field === 'website' ? 300 : field === 'phone' ? 40 : field === 'city' ? 80 : 100)]));
    }

    function businessCard(profile, preview = false) {
        const safe = publicProfile(profile);
        const name = safe.businessName || (preview ? 'Your business name' : 'Local business');
        const initials = name.split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0] || '').join('').toUpperCase();
        const card = node('article', 'business-card');
        const top = node('div', 'card-top');
        const mark = node('span', 'business-mark', safe.businessName ? initials : 'CC');
        mark.setAttribute('aria-hidden', 'true');
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
            const telephone = safe.phone.replace(/[^+\d]/g, '');
            if (/^[+\d().\-\s]+$/.test(safe.phone) && /^\+?\d{7,15}$/.test(telephone) && !preview) {
                const phone = node('a', 'card-phone', safe.phone);
                phone.href = `tel:${telephone}`;
                links.append(phone);
            } else {
                links.append(node('span', 'card-phone', safe.phone));
            }
        }
        card.append(links);
        return card;
    }

    async function request(body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        try {
            const response = await fetch(API, {
                method: body ? 'POST' : 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: controller.signal,
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data || typeof data !== 'object') {
                throw new Error(string(data?.error, 240) || 'Local Spotlight is temporarily unavailable. Please try again.');
            }
            return data;
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('This is taking longer than expected. Please try again.');
            if (error instanceof TypeError) throw new Error('Unable to connect. Check your connection and try again.');
            throw error;
        } finally { clearTimeout(timer); }
    }

    function setEmpty(title, description, { clear = false, retry = false } = {}) {
        byId('directoryEmpty').hidden = false;
        byId('emptyTitle').textContent = title;
        byId('emptyDescription').textContent = description;
        byId('clearFilters').hidden = !clear;
        byId('retryDirectory').hidden = !retry;
    }

    function renderDirectory() {
        if (!directoryLoaded) return;
        const search = byId('businessSearch').value.trim().toLocaleLowerCase();
        const category = byId('categoryFilter').value;
        const filtered = listings.filter((listing) => {
            const searchable = `${listing.businessName} ${listing.city} ${listing.description}`.toLocaleLowerCase();
            return (!category || listing.category === category) && (!search || searchable.includes(search));
        });
        byId('businessGrid').replaceChildren(...filtered.map((listing) => businessCard(listing)));
        byId('directoryEmpty').hidden = Boolean(filtered.length);
        byId('resultsCount').textContent = `${filtered.length} ${filtered.length === 1 ? 'business' : 'businesses'}${search || category ? ` of ${listings.length}` : ' in the spotlight'}`;
        if (!filtered.length) {
            if (search || category) {
                setEmpty('No matches just yet.', 'Try another business name, city, or category.', { clear: true });
            } else {
                setEmpty('No businesses featured yet.', 'Check back soon for local businesses in the spotlight.');
            }
        }
    }

    async function loadDirectory() {
        byId('retryDirectory').disabled = true;
        try {
            const data = await request();
            if (!Array.isArray(data.listings)) throw new Error('Listings unavailable');
            listings = data.listings.filter((item) => item && typeof item.businessName === 'string').map(publicProfile);
            directoryLoaded = true;
            renderDirectory();
        } catch {
            if (!directoryLoaded) {
                byId('resultsCount').textContent = 'Listings could not be loaded.';
                setEmpty('We couldn’t load the listings.', 'Please try again in a moment.', { retry: true });
            }
        } finally {
            byId('retryDirectory').disabled = false;
        }
    }

    byId('businessSearch').addEventListener('input', renderDirectory);
    byId('categoryFilter').addEventListener('change', renderDirectory);
    byId('clearFilters').addEventListener('click', () => {
        byId('businessSearch').value = '';
        byId('categoryFilter').value = '';
        renderDirectory();
        byId('businessSearch').focus();
    });
    byId('retryDirectory').addEventListener('click', loadDirectory);
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
    loadDirectory();
})();
