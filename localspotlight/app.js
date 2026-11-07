'use strict';

(() => {
    const API = '/api/spotlight';
    const PREVIEW_DATA = '/localspotlight/preview/businesses.json';
    const isPreview = document.body.dataset.designPreview === 'true' || /^\/localspotlight\/preview(?:\/|\/index\.html)?$/.test(window.location.pathname);
    const compactDirectory = document.body.classList.contains('directory-first');
    const showcaseDirectory = document.body.classList.contains('category-showcase');
    let pageSize = compactDirectory ? 48 : 20;
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
            if (url.origin === window.location.origin && /^\/localspotlight\/(?:preview\/assets|banners|logos)\/[a-z0-9-]+\.(png|jpg|jpeg|webp|ico|svg|avif)$/.test(url.pathname) && !url.search && !url.hash) return url.href;
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
            id: string(source.id, 100),
            businessName: string(source.businessName, 100), category: isPreview ? string(source.category, 100) : window.CerneySelectsCategories.display(string(source.category, 100)),
            city: string(source.city, 80), address: string(source.address, 200), description: string(source.description, 400),
            website: string(source.website, 300), phone: string(source.phone, 40), logoUrl: string(source.logoUrl, 500), bannerUrl: string(source.bannerUrl, 500),
            ...Object.fromEntries(window.CerneySelectsSocials.platforms.map(({ field }) => [field, string(source[field], 300)])),
            logoBackdrop: isPreview && source.logoBackdrop === 'dark' ? 'dark' : '',
            textWordmark: isPreview && source.textWordmark === true,
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
        body.append(node('p', 'directory-card-category', profile.category || 'Local business'), businessName(profile), node('p', 'directory-city', profile.city));
        if (profile.description) body.append(node('p', 'directory-description', profile.description));
        if (profile.address) {
            const address = link(profile.address + ' ↗', 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(profile.address), 'directory-address', profile.businessName);
            address.setAttribute('aria-label', `View location for ${profile.businessName}: ${profile.address}`);
            body.append(address);
        }
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

    const businessDialog = byId('businessDialog');
    let dialogCloseTimer;
    function closeBusiness() {
        if (!businessDialog.open || businessDialog.classList.contains('is-closing')) return;
        if (reducedMotion.matches) { businessDialog.close(); return; }
        businessDialog.classList.add('is-closing');
        // Keep the modal and focus trap active until its exit transition finishes.
        dialogCloseTimer = setTimeout(() => businessDialog.close(), 180);
    }
    function openBusiness(profile, index) {
        byId('businessDialogTitle').textContent = profile.businessName;
        byId('businessDialogContent').replaceChildren(businessCard(profile, index));
        businessDialog.showModal();
        businessDialog.scrollTop = 0;
    }
    function businessTile(profile, index) {
        if (showcaseDirectory) return showcaseTile(profile, index);
        const tile = node('button', 'business-tile');
        tile.type = 'button';
        tile.setAttribute('aria-label', `View ${profile.businessName} details`);
        tile.setAttribute('aria-haspopup', 'dialog');
        const top = node('span', 'business-tile-art');
        const src = logoUrl(profile.bannerUrl);
        if (src) {
            const banner = node('img', 'business-tile-banner');
            banner.alt = ''; banner.loading = index < 12 ? 'eager' : 'lazy';
            banner.decoding = 'async'; banner.referrerPolicy = 'no-referrer';
            banner.src = src; banner.addEventListener('error', () => banner.remove(), { once: true });
            top.append(banner);
        }
        const mark = businessMark(profile, true);
        const logo = mark.querySelector('img');
        if (logo && index < 12) logo.loading = 'eager';
        top.append(mark);
        const copy = node('span', 'business-tile-copy');
        copy.append(node('span', 'business-tile-name', profile.businessName), node('span', 'business-tile-city', profile.city));
        tile.append(top, copy);
        tile.addEventListener('click', () => openBusiness(profile, index));
        return tile;
    }
    function showcaseTile(profile, index) {
        const tile = node('button', 'business-tile');
        tile.type = 'button';
        tile.setAttribute('aria-label', `View ${profile.businessName} details`);
        tile.setAttribute('aria-haspopup', 'dialog');
        const art = node('span', 'business-tile-art');
        const src = logoUrl(profile.logoUrl);
        if (src) {
            const image = node('img', 'expanded-logo');
            image.alt = ''; image.src = src;
            image.loading = index < 12 ? 'eager' : 'lazy';
            image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
            image.addEventListener('error', () => image.remove(), { once: true });
            art.append(image);
        }
        const copy = node('span', 'business-tile-copy');
        if (/^Sharp Corners\b/i.test(profile.businessName)) {
            copy.append(node('span', 'business-tile-name', 'Sharp Corners'));
            copy.append(node('span', 'business-tile-subtitle', 'Sports Cards & Collectibles'));
        } else copy.append(node('span', `business-tile-name${/\S{12}/.test(profile.businessName) ? ' has-long-word' : ''}`, profile.businessName));
        const arrow = node('span', 'business-tile-arrow', '↗');
        arrow.setAttribute('aria-hidden', 'true');
        tile.append(art, copy, node('span', 'business-tile-city', profile.city), arrow);
        tile.addEventListener('click', () => openBusiness(profile, index));
        return tile;
    }
    if (businessDialog) {
        byId('closeBusinessDialog').addEventListener('click', closeBusiness);
        businessDialog.addEventListener('cancel', event => { event.preventDefault(); closeBusiness(); });
        businessDialog.addEventListener('close', () => {
            clearTimeout(dialogCloseTimer);
            businessDialog.classList.remove('is-closing');
        });
        businessDialog.addEventListener('click', event => {
            const bounds = businessDialog.getBoundingClientRect();
            if (event.target === businessDialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeBusiness();
        });
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
        if (showcaseDirectory) { renderShowcase(); return; }
        const search = byId('businessSearch').value.trim().toLocaleLowerCase();
        const category = byId('categoryFilter').value;
        const city = byId('cityFilter').value;
        document.querySelectorAll('[data-category]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.category === category)));
        const filtered = window.CerneySelectsDailyOrder.order(listings).filter((listing) => {
            const searchable = `${listing.businessName} ${listing.city} ${listing.category} ${listing.description}`.toLocaleLowerCase();
            return matchesCategory(listing, category) && (!city || listing.city === city) && (!search || searchable.includes(search));
        });
        const sortLabel = document.querySelector('.directory-sort');
        if (sortLabel) {
            sortLabel.textContent = 'Rotates daily';
            sortLabel.title = 'Every business takes a turn near the top. The order changes at midnight Pacific.';
        }
        filteredCount = filtered.length;
        const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
        page = Math.min(page, pages);
        const offset = (page - 1) * pageSize;
        const visible = filtered.slice(offset, offset + pageSize);
        byId('businessGrid').classList.toggle('is-text-view', mode === 'text');
        byId('businessGrid').replaceChildren(...visible.map((listing, index) => (compactDirectory ? businessTile : businessCard)(listing, offset + index)));
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

    function renderShowcase() {
        const groups = window.CerneySelectsCategories.groups.map((group, order) => ({
            ...group, order,
            slug: group.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
            members: window.CerneySelectsDailyOrder.order(listings.filter(listing => listing.category === group.label)),
        })).sort((a, b) => b.members.length - a.members.length || a.order - b.order);
        const selected = groups.find(group => window.location.hash === '#category/' + group.slug);
        byId('directoryTitle').textContent = selected ? selected.label : 'Discover Local Businesses';
        byId('categoryBack').hidden = !selected;
        let index = 0;
        const sections = (selected ? [selected] : groups).map(group => {
            const section = node('section', 'business-category-section');
            const heading = node('h2', 'business-category-heading', selected
                ? `${group.members.length} local ${group.members.length === 1 ? 'business' : 'businesses'}` : group.label);
            heading.id = 'category-' + group.slug;
            section.setAttribute('aria-labelledby', heading.id);
            const invitation = node('a', 'category-invitation', selected ? 'List your business ↗' : `View all (${group.members.length}) →`);
            invitation.href = selected ? '/apply/' : '#category/' + group.slug;
            if (!selected) invitation.setAttribute('aria-label', `View all ${group.members.length} ${group.members.length === 1 ? 'business' : 'businesses'} in ${group.label}`);
            const row = node('div', 'business-category-header');
            row.append(heading, invitation);
            const grid = node('div', 'category-logo-grid');
            grid.append(...group.members.map(profile => businessTile(profile, index++)));
            section.append(row, grid);
            if (!group.members.length) section.append(node('p', 'category-empty', 'More local businesses coming soon.'));
            return section;
        });
        byId('businessGrid').classList.remove('is-loading');
        byId('businessGrid').replaceChildren(...sections);
        byId('directoryEmpty').hidden = true;
        const count = selected ? selected.members.length : listings.length;
        byId('resultsCount').textContent = `${count} ${count === 1 ? 'business' : 'businesses'}${selected ? ' in ' + selected.label : ' across five categories'}`;
    }

    if (showcaseDirectory) {
        let lastHash = window.location.hash;
        window.addEventListener('hashchange', () => {
            const hash = window.location.hash;
            const categoryNavigation = hash.startsWith('#category/') || lastHash.startsWith('#category/');
            lastHash = hash;
            if (!categoryNavigation) return;
            renderDirectory();
            byId('menuToggle').setAttribute('aria-expanded', 'false');
            byId('primaryLinks').classList.remove('is-open');
            // Preserve normal anchor navigation to About and other page content.
            if (!hash || hash === '#businesses' || hash.startsWith('#category/')) {
                byId('directoryTitle').focus({ preventScroll: true });
                window.scrollTo({ top: 0, behavior: 'instant' });
                animateCategoryResults();
            }
        });
    }

    function populateCities() {
        if (!byId('cityFilter')) return;
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
        // Keep the vetted sample order when selecting the preview size.
        listings = allListings.slice(0, COUNTS.includes(count) ? count : 20);
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
            else { listings = allListings; populateCities(); renderDirectory(); }
        } catch {
            if (!directoryLoaded) {
                byId('businessGrid').replaceChildren();
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
    byId('businessSearch')?.addEventListener('input', resetPage);
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
    byId('cityFilter')?.addEventListener('change', resetPage);
    byId('clearFilters').addEventListener('click', () => {
        if (showcaseDirectory) return;
        byId('businessSearch').value = ''; byId('categoryFilter').value = ''; byId('cityFilter').value = '';
        resetPage(); byId('businessSearch').focus();
        revealSelectedCategory();
    });
    byId('retryDirectory').addEventListener('click', loadDirectory);
    for (const [id, direction] of [['previousPage', -1], ['nextPage', 1]]) {
        byId(id)?.addEventListener('click', () => {
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
    // Also rotate a directory left open overnight, using the same Pacific day
    // as the ordering module. Avoid rebuilding cards while a visitor reads one.
    let renderedDay = window.CerneySelectsDailyOrder.dayNumber();
    setInterval(() => {
        const today = window.CerneySelectsDailyOrder.dayNumber();
        if (today !== renderedDay && !document.hidden && !businessDialog?.open) {
            renderedDay = today;
            renderDirectory();
        }
    }, 60000);
    loadDirectory();
})();
