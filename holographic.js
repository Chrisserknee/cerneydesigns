(() => {
    'use strict';

    const sheen = document.createElement('div');
    sheen.className = 'holographic-sheen';
    sheen.setAttribute('aria-hidden', 'true');
    document.body.appendChild(sheen);

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animationFrame = 0;

    function updateSheen() {
        animationFrame = 0;
        if (reducedMotion.matches) {
            sheen.style.setProperty('--holo-shift', '0');
            return;
        }

        const scrollable = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
        const progress = Math.min(Math.max(window.scrollY / scrollable, 0), 1);
        const shift = (progress - 0.5) * 96;
        sheen.style.setProperty('--holo-shift', shift.toFixed(2));
    }

    function requestUpdate() {
        if (!animationFrame) animationFrame = window.requestAnimationFrame(updateSheen);
    }

    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate, { passive: true });
    reducedMotion.addEventListener?.('change', requestUpdate);
    updateSheen();
})();
