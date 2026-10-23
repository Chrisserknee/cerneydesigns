(() => {
    'use strict';
    const hero = document.querySelector('.spotlight-hero-sticker');
    const dock = document.querySelector('.nav-character');
    const header = document.querySelector('.site-header');
    if (!hero || !dock || !header) return;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const flight = hero.cloneNode();
    flight.className = 'hero-character-flight';
    flight.alt = '';
    flight.setAttribute('aria-hidden', 'true');
    flight.hidden = true;
    document.body.append(flight);
    let scheduled = false;
    function render() {
        scheduled = false;
        const from = hero.getBoundingClientRect();
        const to = dock.getBoundingClientRect();
        const distance = Math.max(120, from.top + scrollY - header.getBoundingClientRect().bottom);
        const progress = Math.max(0, Math.min(1, scrollY / distance));
        const docked = progress === 1;
        const flying = progress > 0 && !docked && !reducedMotion.matches;
        hero.style.visibility = docked || flying ? 'hidden' : 'visible';
        dock.style.visibility = docked ? 'visible' : 'hidden';
        flight.hidden = !flying;
        if (!flying || !from.width) return;
        const blend = progress * progress * (3 - 2 * progress);
        const x = from.left + (to.left - from.left) * blend;
        const y = from.top + (to.top - from.top) * blend;
        const scale = 1 + (to.width / from.width - 1) * blend;
        flight.style.width = `${from.width}px`;
        flight.style.height = `${from.height}px`;
        flight.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }
    function schedule() {
        if (!scheduled) { scheduled = true; requestAnimationFrame(render); }
    }
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule);
    addEventListener('pageshow', schedule);
    hero.addEventListener('load', schedule);
    reducedMotion.addEventListener('change', schedule);
    document.fonts?.ready.then(schedule);
    schedule();
})();
