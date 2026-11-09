(() => {
    'use strict';
    // Enable only after the owner approves a Vercel plan with custom events.
    const customEventsEnabled = false;
    const selectsHosts = new Set(['cerneyselects.com', 'www.cerneyselects.com']);
    const newsHosts = new Set(['chriscerney.org', 'www.chriscerney.org']);
    const selectsPaths = new Set(['/', '/apply', '/privacy', '/terms']);
    const newsPaths = new Set(['/', '/news', '/news/privacy.html', '/portfolio', '/merchandise', '/upload', '/submit-story', '/community-help', '/newsroom']);
    const actions = new Set(['business_open', 'business_website', 'business_call', 'business_social', 'category_open', 'navigation', 'outbound', 'contact', 'menu', 'news_filter', 'news_join', 'video_play', 'checkout_click', 'billing_click']);
    const scriptPath = '/_vercel/insights/script.js';
    const cleanPath = value => value.replace(/\/index\.html$/, '/').replace(/\/$/, '') || '/';
    function publicPage(value) {
        try {
            const url = new URL(value);
            const paths = selectsHosts.has(url.hostname) ? selectsPaths : newsHosts.has(url.hostname) ? newsPaths : null;
            if (url.protocol !== 'https:' || !paths?.has(cleanPath(url.pathname))) return null;
            url.search = ''; url.hash = '';
            return url.href;
        } catch { return null; }
    }
    function safeTarget(value) {
        return typeof value === 'string' && /^[a-z0-9][a-z0-9 ._&/-]{0,89}$/i.test(value) ? value : null;
    }
    if (!publicPage(window.location.href) || document.querySelector(`script[src="${scriptPath}"]`)) return;
    window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    window.va('beforeSend', event => {
        const url = publicPage(event.url);
        if (!url) return null;
        if (event.type === 'pageview') return { ...event, url };
        if (!customEventsEnabled || event.type !== 'event' || event.name !== 'Site interaction'
            || !actions.has(event.data?.action) || !safeTarget(event.data?.target)) return null;
        // Exactly two controlled properties: no form values, raw URLs or IDs.
        return { ...event, url, data: { action: event.data.action, target: event.data.target } };
    });
    function track(action, target) {
        if (!customEventsEnabled || !publicPage(window.location.href) || !actions.has(action) || !safeTarget(target)) return;
        window.va('event', { name: 'Site interaction', data: { action, target } });
    }
    document.addEventListener('click', event => {
        const el = event.target?.closest?.('a, button');
        if (!el || el.disabled) return;
        if (el.dataset.analyticsAction) { track(el.dataset.analyticsAction, el.dataset.analyticsTarget); return; }
        const business = el.closest('[data-analytics-business]')?.dataset.analyticsBusiness;
        const href = el.getAttribute('href');
        if (href) {
            let url; try { url = new URL(href, window.location.href); } catch { return; }
            if (url.protocol === 'tel:') { track(business ? 'business_call' : 'contact', business || 'phone'); return; }
            if (url.protocol === 'mailto:') { track('contact', 'email'); return; }
            if (!['http:', 'https:'].includes(url.protocol)) return;
            if (business) { track(/(^|\.)(instagram|facebook|tiktok)\.com$/.test(url.hostname) ? 'business_social' : 'business_website', business); return; }
            if (url.origin === new URL(window.location.href).origin) {
                if (/^#category\/[a-z-]+$/.test(url.hash)) track('category_open', url.hash.slice(10));
                else if (['#about', '#contact', '#home', '#businesses'].includes(url.hash)) track('navigation', url.hash.slice(1));
                else if (publicPage(url.href) || ['/gofundme', '/support'].includes(cleanPath(url.pathname))) track('navigation', cleanPath(url.pathname) === '/' ? 'home' : cleanPath(url.pathname).slice(1));
            } else { track('outbound', url.hostname); }
            return;
        }
        if (['menuToggle', 'navToggle'].includes(el.id)) track('menu', 'main');
        if (el.id === 'checkoutButton') track('checkout_click', 'application');
        if (el.id === 'portalButton') track('billing_click', 'stripe');
        if (['all', 'video', 'image', 'saved'].includes(el.dataset.view)) track('news_filter', el.dataset.view);
        if (el.classList.contains('account-button')) track('news_join', 'account');
    }, true);
    const played = new WeakSet();
    document.addEventListener('play', event => {
        if (event.target?.tagName !== 'VIDEO' || played.has(event.target)) return;
        played.add(event.target); track('video_play', cleanPath(new URL(window.location.href).pathname).slice(1) || 'home');
    }, true);
    const script = document.createElement('script'); script.src = scriptPath; script.defer = true;
    document.head.appendChild(script);
})();
