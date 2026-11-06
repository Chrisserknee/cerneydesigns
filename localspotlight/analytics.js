(() => {
    'use strict';

    const publicHosts = new Set(['cerneyselects.com', 'www.cerneyselects.com']);
    const publicPaths = new Set(['/', '/apply', '/apply/', '/privacy/', '/terms/']);
    const scriptPath = '/_vercel/insights/script.js';

    function publicPage(value) {
        try {
            const url = new URL(value);
            if (url.protocol !== 'https:' || !publicHosts.has(url.hostname)
                || !publicPaths.has(url.pathname)) return null;
            // Checkout return URLs can contain session identifiers. Neither
            // query strings nor fragments belong in audience measurements.
            url.search = '';
            url.hash = '';
            return url.href;
        } catch {
            return null;
        }
    }

    // Shared assets also serve previews and the reporting site. Only measure
    // the public Cerney Selects pages, never private or local review sessions.
    if (!publicPage(window.location.href)
        || document.querySelector(`script[src="${scriptPath}"]`)) return;

    window.va = window.va || function () {
        (window.vaq = window.vaq || []).push(arguments);
    };
    window.va('beforeSend', (event) => {
        const url = publicPage(event.url);
        return event.type === 'pageview' && url ? { ...event, url } : null;
    });

    const script = document.createElement('script');
    script.src = scriptPath;
    script.defer = true;
    document.head.appendChild(script);
})();
