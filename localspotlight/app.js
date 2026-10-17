'use strict';

(() => {
    const API = '/api/spotlight';
    const PREVIEW_DATA = '/localspotlight/preview/businesses.json';
    const isPreview = /^\/localspotlight\/preview(?:\/|\/index\.html)?$/.test(window.location.pathname);
    let pageSize = 20;
    const COUNTS = [10, 20, 30, 60, 80, 100];
    const MODES = ['logos', 'cards', 'text', 'mixed'];
    const byId = (id) => document.getElementById(id);
    let allListings = [];
    let listings = [];
    let directoryLoaded = false;
    let page = 1;
    let mode = 'logos';
    let filteredCount = 0;

    function string(value, max = 400) {
        return typeof value === 'string' ? value.trim().slice(0, max) : '';
    }

    function websiteUrl(value, max = 300) {
        try {
            const url = new URL(string(value, max));
            if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password || url.port || url.hostname === 'localhost' || url.hostname.endsWith('.local') || /^[\d.]+$/.test(url.hostname)) return '';
            return url.href;
        } catch { return ''; }
    }

    function logoUrl(value) {
        const raw = string(value, 500);
        if (!raw) return '';
        try {
            const url = new URL(raw, window.location.origin);
            if (url.origin === window.location.origin && /^\/localspotlight\/preview\/assets\/[a-z0-9-]+\.(png|jpg|jpeg|webp|ico|svg)$/.test(url.pathname) && !url.search && !url.hash) return url.href;
            // Remote logos still obey the site's image CSP. A blocked or failed asset becomes initials.
            return websiteUrl(raw, 500);
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
        return {
            businessName: string(source.businessName, 100), category: string(source.category, 100),
            city: string(source.city, 80), description: string(source.description, 400),
            website: string(source.website, 300), phone: string(source.phone, 40), logoUrl: string(source.logoUrl, 500),
        };
    }

    function link(label, href, className, businessName) {
        const element = node('a', className, label);
        element.href = href;
        element.target = '_blank';
        element.rel = `${isPreview ? '' : 'sponsored '}noopener noreferrer`;
        element.setAttribute('aria-label', `${businessName || label} website (opens in a new tab)`);
        return element;
    }

    function businessName(profile) {
        const heading = node('h3');
        const href = websiteUrl(profile.website);
        heading.append(href ? link(profile.businessName, href, 'directory-name') : node('span', 'directory-name', profile.businessName));
        return heading;
    }

    function businessMark(profile, useLogo) {
        const initials = profile.businessName.split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0] || '').join('').toUpperCase();
        const mark = node('span', 'directory-mark', initials);
        mark.setAttribute('aria-hidden', 'true');
        const src = useLogo ? logoUrl(profile.logoUrl) : '';
        if (src) {
            const image = node('img');
            image.alt = '';
            image.loading = 'lazy';
            image.decoding = 'async';
            image.referrerPolicy = 'no-referrer';
            image.addEventListener('load', () => {
                const ratio = image.naturalWidth / image.naturalHeight;
                if (Math.max(image.naturalWidth, image.naturalHeight) < 64) {
                    mark.classList.remove('has-logo');
                    mark.replaceChildren(document.createTextNode(initials));
                    return;
                }
                mark.classList.toggle('wide-logo', ratio > 2);
                mark.classList.toggle('tall-logo', ratio < .8);
            }, { once: true });
            image.addEventListener('error', () => { mark.classList.remove('has-logo'); mark.replaceChildren(document.createTextNode(initials)); }, { once: true });
            image.src = src;
            mark.classList.add('has-logo');
            mark.replaceChildren(image);
        }
        return mark;
    }

    function businessCard(profile, index) {
        if (mode === 'text') {
            const row = node('article', 'directory-text-row');
            const content = node('div');
            content.append(businessName(profile), node('p', 'directory-text-meta', [profile.city, profile.category].filter(Boolean).join(' · ')));
            const arrow = node('span', 'directory-text-arrow', '↗');
            arrow.setAttribute('aria-hidden', 'true');
            row.append(content, arrow);
            return row;
        }
        const showMark = mode !== 'cards';
        const card = node('article', `directory-card${showMark ? '' : ' without-logo'}`);
        const tone = Array.from(profile.businessName).reduce((total, char) => total + char.codePointAt(0), 0) % 4;
        card.dataset.tone = String(tone);
        if (showMark) {
            const top = node('div', 'directory-card-top');
            top.append(businessMark(profile, mode !== 'mixed' || index % 3 !== 1));
            card.append(top);
        }
        card.append(node('p', 'directory-card-category', profile.category || 'Local business'), businessName(profile), node('p', 'directory-city', profile.city));
        if (profile.description) card.append(node('p', 'directory-description', profile.description));
        const bottom = node('div', 'directory-card-bottom');
        const href = websiteUrl(profile.website);
        if (href) bottom.append(link('Visit website ↗', href, 'directory-site-link', profile.businessName));
        if (profile.phone) {
            const telephone = profile.phone.replace(/[^+\d]/g, '');
            const phone = node('span', 'directory-phone', profile.phone);
            if (/^[+\d().\-\s]+$/.test(profile.phone) && /^\+?\d{7,15}$/.test(telephone)) {
                const phoneLink = node('a', 'directory-phone', profile.phone);
                phoneLink.href = `tel:${telephone}`;
                bottom.append(phoneLink);
            } else bottom.append(phone);
        }
        if (bottom.childElementCount) card.append(bottom);
        return card;
    }

    async function request() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        try {
            const response = await fetch(isPreview ? PREVIEW_DATA : API, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data || typeof data !== 'object') throw new Error('Listings unavailable');
            return data;
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
        const city = byId('cityFilter').value;
        const filtered = listings.filter((listing) => {
            const searchable = `${listing.businessName} ${listing.city} ${listing.category} ${listing.description}`.toLocaleLowerCase();
            return (!category || listing.category === category) && (!city || listing.city === city) && (!search || searchable.includes(search));
        });
        filteredCount = filtered.length;
        const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
        page = Math.min(page, pages);
        const offset = (page - 1) * pageSize;
        const visible = filtered.slice(offset, offset + pageSize);
        byId('businessGrid').classList.toggle('is-text-view', mode === 'text');
        byId('businessGrid').replaceChildren(...visible.map((listing, index) => businessCard(listing, offset + index)));
        byId('directoryEmpty').hidden = Boolean(filtered.length);
        const noun = filtered.length === 1 ? 'business' : 'businesses';
        const suffix = isPreview ? ' · design examples' : '';
        byId('resultsCount').textContent = `${filtered.length} ${noun}${search || category || city ? ` of ${listings.length}` : ''}${suffix}${filtered.length > pageSize ? ` · showing ${offset + 1}–${offset + visible.length}` : ''}`;
        byId('directoryPagination').hidden = pages <= 1;
        byId('pageCount').textContent = `Page ${page} of ${pages}`;
        byId('previousPage').disabled = page === 1;
        byId('nextPage').disabled = page === pages;
        if (!filtered.length) {
            if (search || category || city) setEmpty('No matches just yet.', 'Try another business name, community, or category.', { clear: true });
            else setEmpty('No businesses featured yet.', 'Check back soon to discover local businesses in the spotlight.');
        }
    }

    function populateCities() {
        const selected = byId('cityFilter').value;
        const cities = [...new Set(listings.map((listing) => listing.city).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        const options = [node('option', '', 'All cities'), ...cities.map((city) => node('option', '', city))];
        options[0].value = '';
        byId('cityFilter').replaceChildren(...options);
        if (cities.includes(selected)) byId('cityFilter').value = selected;
    }

    function applyPreview() {
        const count = Number(byId('previewCount').value);
        pageSize = byId('previewShowAll').checked ? 100 : 20;
        mode = MODES.includes(byId('previewMode').value) ? byId('previewMode').value : 'logos';
        // The vetted source order is intentionally varied; sorting applies only after selecting the count.
        listings = allListings.slice(0, COUNTS.includes(count) ? count : 20).sort((a, b) => a.businessName.localeCompare(b.businessName));
        page = 1;
        populateCities();
        renderDirectory();
        const params = new URLSearchParams({ count: String(count), view: mode, layout: pageSize === 100 ? 'all' : 'pages' });
        history.replaceState(null, '', `${window.location.pathname}?${params}`);
    }

    async function loadDirectory() {
        byId('retryDirectory').disabled = true;
        try {
            const data = await request();
            if (!Array.isArray(data.listings)) throw new Error('Listings unavailable');
            allListings = data.listings.filter((item) => item && typeof item.businessName === 'string' && item.businessName.trim()).map(publicProfile);
            directoryLoaded = true;
            if (isPreview) applyPreview();
            else { listings = allListings.sort((a, b) => a.businessName.localeCompare(b.businessName)); populateCities(); renderDirectory(); }
        } catch {
            if (!directoryLoaded) {
                byId('resultsCount').textContent = 'Listings could not be loaded.';
                setEmpty('We couldn’t load the listings.', 'Please try again in a moment.', { retry: true });
            }
        } finally { byId('retryDirectory').disabled = false; }
    }

    function resetPage() { page = 1; renderDirectory(); }
    byId('businessSearch').addEventListener('input', resetPage);
    byId('categoryFilter').addEventListener('change', resetPage);
    byId('cityFilter').addEventListener('change', resetPage);
    byId('clearFilters').addEventListener('click', () => {
        byId('businessSearch').value = ''; byId('categoryFilter').value = ''; byId('cityFilter').value = '';
        resetPage(); byId('businessSearch').focus();
    });
    byId('retryDirectory').addEventListener('click', loadDirectory);
    for (const [id, direction] of [['previousPage', -1], ['nextPage', 1]]) {
        byId(id).addEventListener('click', () => {
            page = Math.max(1, Math.min(page + direction, Math.ceil(filteredCount / pageSize)));
            renderDirectory();
            byId('businessGrid').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
        });
    }
    byId('menuToggle').addEventListener('click', () => {
        const open = byId('menuToggle').getAttribute('aria-expanded') !== 'true';
        byId('menuToggle').setAttribute('aria-expanded', String(open)); byId('primaryLinks').classList.toggle('is-open', open);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && byId('primaryLinks').classList.contains('is-open')) {
            byId('menuToggle').setAttribute('aria-expanded', 'false'); byId('primaryLinks').classList.remove('is-open'); byId('menuToggle').focus();
        }
    });
    if (isPreview) {
        const params = new URLSearchParams(window.location.search);
        if (COUNTS.includes(Number(params.get('count')))) byId('previewCount').value = params.get('count');
        if (MODES.includes(params.get('view'))) byId('previewMode').value = params.get('view');
        byId('previewShowAll').checked = params.get('layout') !== 'pages';
        byId('previewShowAll').addEventListener('change', applyPreview);
        byId('previewCount').addEventListener('change', applyPreview);
        byId('previewMode').addEventListener('change', applyPreview);
    }
    loadDirectory();
})();
