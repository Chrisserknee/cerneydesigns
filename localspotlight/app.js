'use strict';

(() => {
    const API = '/api/spotlight';
    const PREVIEW_DATA = '/localspotlight/preview/businesses.json';
    const isPreview = document.body.dataset.designPreview === 'true' || /^\/localspotlight\/preview(?:\/|\/index\.html)?$/.test(window.location.pathname);
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
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let categoryAnimations = [];

    function stopCategoryAnimations() {
        categoryAnimations.forEach(animation => animation.cancel());
        categoryAnimations = [];
    }
    reducedMotion.addEventListener('change', stopCategoryAnimations);

    function animateCategoryResults() {
        if (reducedMotion.matches) return;
        const grid = byId('businessGrid');
        const items = byId('directoryEmpty').hidden ? Array.from(grid.children) : [byId('directoryEmpty')];
        // Animate only the first visible cards, so long directories stay light.
        items.filter(item => {
            const bounds = item.getBoundingClientRect();
            return bounds.top < window.innerHeight && bounds.bottom > 0;
        }).slice(0, 8).forEach((item, index) => {
            if (typeof item.animate !== 'function') return;
            categoryAnimations.push(item.animate([
                { opacity: 0, transform: 'translateY(10px)' },
                { opacity: 1, transform: 'translateY(0)' },
            ], { duration: 280, delay: index * 24, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' }));
        });
    }

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
            if (url.origin === window.location.origin && /^\/localspotlight\/preview\/assets\/[a-z0-9-]+\.(png|jpg|jpeg|webp|ico|svg|avif)$/.test(url.pathname) && !url.search && !url.hash) return url.href;
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
            website: string(source.website, 300), phone: string(source.phone, 40), logoUrl: string(source.logoUrl, 500), bannerUrl: string(source.bannerUrl, 500),
            ...Object.fromEntries(window.CerneySelectsSocials.platforms.map(({ field }) => [field, string(source[field], 300)])),
            logoBackdrop: isPreview && source.logoBackdrop === 'dark' ? 'dark' : '',
            textWordmark: isPreview && source.textWordmark === true,
            featuredSpecialty: source.featured?.area === 'Monterey County' ? string(source.featured.specialty, 80) : '',
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
        if (profile.textWordmark && useLogo) {
            mark.classList.add('text-wordmark');
            mark.textContent = profile.businessName;
            return mark;
        }
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
            if (profile.featuredSpecialty) content.append(node('p', 'featured-badge', `Featured ${profile.featuredSpecialty} · Monterey County`));
            content.append(businessName(profile), node('p', 'directory-text-meta', [profile.city, profile.category].filter(Boolean).join(' · ')));
            const arrow = node('span', 'directory-text-arrow', '↗');
            arrow.setAttribute('aria-hidden', 'true');
            row.append(content, window.CerneySelectsSocialLinks(profile) || arrow);
            return row;
        }
        const showMark = mode !== 'cards';
        const card = node('article', `directory-card${showMark ? '' : ' without-logo'}`);
        const tone = Array.from(profile.businessName).reduce((total, char) => total + char.codePointAt(0), 0) % 4;
        card.dataset.tone = String(tone);
        if (showMark) {
            const top = node('div', 'directory-card-top');
            if (profile.logoBackdrop) top.classList.add('dark-logo-backdrop');
            const bannerSrc = logoUrl(profile.bannerUrl);
            if (bannerSrc) {
                const banner = node('img', 'directory-banner');
                banner.alt = ''; banner.loading = 'lazy'; banner.decoding = 'async'; banner.referrerPolicy = 'no-referrer';
                banner.width = 1200; banner.height = 600; banner.src = bannerSrc;
                top.classList.add('has-banner');
                banner.addEventListener('error', () => { banner.remove(); top.classList.remove('has-banner'); }, { once: true });
                top.append(banner);
            }
            top.append(businessMark(profile, mode !== 'mixed' || index % 3 !== 1));
            card.append(top);
        }
        const body = node('div', 'directory-card-body');
        if (profile.featuredSpecialty) body.append(node('p', 'featured-badge', `Featured ${profile.featuredSpecialty} · Monterey County`));
        body.append(node('p', 'directory-card-category', profile.category || 'Local business'), businessName(profile), node('p', 'directory-city', profile.city));
        if (profile.description) body.append(node('p', 'directory-description', profile.description));
        const bottom = node('div', 'directory-card-bottom');
        const href = websiteUrl(profile.website);
        if (href) bottom.append(link('Visit website ↗', href, 'directory-site-link', profile.businessName));
        if (profile.phone) {
            const contact = window.CerneySelectsPhone(profile.phone);
            const phone = node(contact.href ? 'a' : 'span', 'directory-phone');
            if (contact.href) {
                phone.href = contact.href;
                phone.setAttribute('aria-label', `Call ${profile.businessName} at ${contact.display}`);
                phone.append(node('span', 'contact-phone-label', 'Call'));
            }
            phone.append(node('span', 'contact-phone-number', contact.display));
            bottom.append(phone);
        }
        const socials = window.CerneySelectsSocialLinks(profile);
        if (socials) bottom.append(socials);
        if (bottom.childElementCount) body.append(bottom);
        card.append(body);
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
        if (byId('emptyApply')) byId('emptyApply').hidden = clear || retry;
    }

    function matchesCategory(listing, category) {
        const text = `${listing.businessName} ${listing.description}`.toLowerCase();
        if (category === 'wine') return /\b(winery|wineries|vineyards|wine bar|wine shop|wine market|wine tasting|tasting room)\b/.test(text) && !/\b(hotel|inn|lodge|resort)\b/i.test(listing.businessName);
        if (category === 'hotels') return /\b(hotel|hotels|motel|motels|inn|resort|resorts|lodge|cottages)\b/.test(text);
        return !category || listing.category === category;
    }

    function renderDirectory() {
        if (!directoryLoaded) return;
        stopCategoryAnimations();
        const search = byId('businessSearch').value.trim().toLocaleLowerCase();
        const category = byId('categoryFilter').value;
        const city = byId('cityFilter').value;
        document.querySelectorAll('[data-category]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.category === category)));
        const filtered = listings.filter((listing) => {
            const searchable = `${listing.businessName} ${listing.city} ${listing.category} ${listing.description}`.toLocaleLowerCase();
            return matchesCategory(listing, category) && (!city || listing.city === city) && (!search || searchable.includes(search));
        });
        // Only server-verified featured entitlements affect priority; every base listing uses the same card geometry.
        const sortLabel = document.querySelector('.directory-sort');
        if (sortLabel) sortLabel.textContent = listings.some(listing => listing.featuredSpecialty) ? 'Featured, then A–Z' : 'Businesses A–Z';
        filtered.sort((a, b) => Number(!!b.featuredSpecialty) - Number(!!a.featuredSpecialty));
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
            else setEmpty('Be part of the first selects.', 'We’re welcoming the first businesses to Cerney Selects. Own a local business? Explore how to join.');
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

    const categoryBrowser = byId('categoryBrowser');
    const categoryChips = byId('categoryChips');
    const categoryExpand = byId('categoryExpand');
    const mobileCategories = window.matchMedia('(max-width: 600px)');

    function revealSelectedCategory() {
        if (!categoryChips || !mobileCategories.matches || categoryBrowser.classList.contains('categories-expanded')) return;
        const selected = categoryChips.querySelector('[aria-pressed="true"]');
        if (!selected) return;
        // Move only this horizontal row, never the page or the business results.
        categoryChips.scrollLeft += selected.getBoundingClientRect().left - categoryChips.getBoundingClientRect().left - 1;
    }

    function setCategoriesExpanded(expanded) {
        if (!categoryBrowser || !categoryExpand) return;
        categoryBrowser.classList.toggle('categories-expanded', expanded);
        categoryExpand.setAttribute('aria-expanded', String(expanded));
        byId('categoryExpandLabel').textContent = expanded ? 'Show less' : 'Show all';
        categoryExpand.querySelector('.category-expand-icon').textContent = expanded ? '−' : '+';
        if (!expanded) requestAnimationFrame(revealSelectedCategory);
    }

    if (categoryBrowser && categoryChips && categoryExpand) {
        categoryBrowser.classList.add('is-enhanced');
        categoryExpand.hidden = false;
        categoryExpand.addEventListener('click', () => setCategoriesExpanded(categoryExpand.getAttribute('aria-expanded') !== 'true'));
        mobileCategories.addEventListener('change', () => setCategoriesExpanded(false));
    }

    function resetPage() { page = 1; renderDirectory(); }
    byId('businessSearch').addEventListener('input', resetPage);
    document.querySelectorAll('[data-category]').forEach(button => {
        button.addEventListener('click', () => {
            if (byId('categoryFilter').value === button.dataset.category) {
                if (mobileCategories.matches) setCategoriesExpanded(false);
                return;
            }
            byId('categoryFilter').value = button.dataset.category;
            resetPage();
            if (mobileCategories.matches) setCategoriesExpanded(false);
            animateCategoryResults();
        });
    });
    byId('cityFilter').addEventListener('change', resetPage);
    byId('clearFilters').addEventListener('click', () => {
        byId('businessSearch').value = ''; byId('categoryFilter').value = ''; byId('cityFilter').value = '';
        resetPage(); byId('businessSearch').focus();
        revealSelectedCategory();
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
        byId('previewShowAll').checked = params.get('layout') === 'all';
        byId('previewShowAll').addEventListener('change', applyPreview);
        byId('previewCount').addEventListener('change', applyPreview);
        byId('previewMode').addEventListener('change', applyPreview);
    }
    function scheduleWeeklyRefresh() {
        const weekLength = 7 * 86400000;
        const elapsed = ((Date.now() - Date.UTC(2026, 0, 5)) % weekLength + weekLength) % weekLength;
        setTimeout(() => { renderDirectory(); scheduleWeeklyRefresh(); }, weekLength - elapsed + 100);
    }
    scheduleWeeklyRefresh();
    loadDirectory();
})();
