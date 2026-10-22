'use strict';
(() => {
    const shapes = {
        instagramUrl: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 5 }], ['circle', { cx: 12, cy: 12, r: 4 }], ['circle', { cx: 17.5, cy: 6.5, r: .8, fill: 'currentColor', stroke: 'none' }]],
        facebookUrl: [['path', { d: 'M14 21v-8h3l.5-4H14V7c0-1 .3-2 2-2h2V2.4C17 2.1 16 2 15 2c-3 0-5 2-5 5v2H7v4h3v8', fill: 'currentColor', stroke: 'none' }]],
        tiktokUrl: [['path', { d: 'M14 3v12.5a4.5 4.5 0 1 1-4-4.47M14 3c.5 3.5 2.5 5.5 6 5.5' }]],
    };
    window.CerneySelectsSocialLinks = function (profile, { preview = false, labels = false } = {}) {
        const group = document.createElement('div');
        group.className = 'business-socials';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', `${profile.businessName || 'Business'} social media`);
        for (const { field, name } of window.CerneySelectsSocials.platforms) {
            let href;
            try { href = window.CerneySelectsSocials.normalize(field, profile[field]); } catch { continue; }
            if (!href) continue;
            const link = document.createElement(preview ? 'span' : 'a');
            link.className = 'business-social-link';
            link.title = name;
            link.setAttribute('aria-label', `${profile.businessName || 'Business'} on ${name}${preview ? '' : ' (opens in a new tab)'}`);
            if (!preview) { link.href = href; link.target = '_blank'; link.rel = 'sponsored noopener noreferrer'; link.referrerPolicy = 'no-referrer'; }
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
            for (const [tag, attributes] of shapes[field]) {
                const shape = document.createElementNS('http://www.w3.org/2000/svg', tag);
                for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
                svg.append(shape);
            }
            link.append(svg);
            if (labels) { const label = document.createElement('span'); label.textContent = name; link.append(label); }
            group.append(link);
        }
        return group.childElementCount ? group : null;
    };
})();
