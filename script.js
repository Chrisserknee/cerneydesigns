// ================================================================
// CHRIS CERNEY - CINEMATIC PORTFOLIO
// Advanced interactions & animations
// ================================================================

(() => {
    'use strict';

    // ==================== CURSOR GLOW ====================
    const cursorGlow = document.getElementById('cursorGlow');
    let mouseX = 0, mouseY = 0;
    let glowX = 0, glowY = 0;

    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    function animateCursorGlow() {
        // Smooth lerp for cursor glow
        glowX += (mouseX - glowX) * 0.08;
        glowY += (mouseY - glowY) * 0.08;
        if (cursorGlow) {
            cursorGlow.style.left = glowX + 'px';
            cursorGlow.style.top = glowY + 'px';
        }
        requestAnimationFrame(animateCursorGlow);
    }

    // Only enable cursor glow on non-touch devices
    if (cursorGlow && window.matchMedia('(pointer: fine)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        animateCursorGlow();
    }

    // ==================== SCROLL PROGRESS BAR ====================
    const scrollProgress = document.getElementById('scrollProgress');

    function updateScrollProgress() {
        const scrollTop = window.scrollY;
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        const scrollPercent = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
        if (scrollProgress) {
            scrollProgress.style.width = scrollPercent + '%';
        }
    }

    // ==================== NAVIGATION ====================
    const navToggle = document.getElementById('navToggle');
    const navMenu = document.getElementById('navMenu');
    const navbar = document.getElementById('navbar');

    const mobileNavigation = window.matchMedia('(max-width: 1140px)');
    function setNavigationOpen(open) {
        navToggle.classList.toggle('active', open);
        navToggle.setAttribute('aria-expanded', String(open));
        navMenu.classList.toggle('open', open);
        navMenu.inert = mobileNavigation.matches && !open;
        document.body.style.overflow = open && mobileNavigation.matches ? 'hidden' : '';
    }
    navToggle.addEventListener('click', () => setNavigationOpen(!navMenu.classList.contains('open')));
    navMenu.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => setNavigationOpen(false));
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && navMenu.classList.contains('open')) {
            setNavigationOpen(false);
            navToggle.focus();
        }
    });
    mobileNavigation.addEventListener('change', () => setNavigationOpen(false));
    setNavigationOpen(false);

    // Navbar shrink on scroll
    let lastScroll = 0;

    function handleNavScroll() {
        const currentScroll = window.scrollY;

        if (currentScroll > 80) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }

        lastScroll = currentScroll;
    }

    // ==================== REVEAL ANIMATIONS ====================
    const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                revealObserver.unobserve(entry.target);
            }
        });
    }, {
        root: null,
        rootMargin: '0px 0px -60px 0px',
        threshold: 0.1
    });

    // Observe all reveal elements
    document.querySelectorAll('.reveal-text, .reveal-section').forEach(el => {
        revealObserver.observe(el);
    });

    // ==================== HERO TEXT ANIMATION ====================
    // Trigger hero reveal texts on load
    window.addEventListener('load', () => {
        document.querySelectorAll('.hero-content .reveal-text').forEach(el => {
            const delay = parseFloat(getComputedStyle(el).getPropertyValue('--delay')) || 0;
            setTimeout(() => {
                el.classList.add('visible');
            }, delay * 1000 + 300);
        });
    });

    // ==================== ACTIVE NAV LINK ====================
    const sections = document.querySelectorAll('section[id]');

    function highlightNavLink() {
        const scrollY = window.scrollY + 150;

        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            const sectionHeight = section.offsetHeight;
            const sectionId = section.getAttribute('id');
            const navLink = document.querySelector(`.nav-menu a[href="#${sectionId}"]`);

            if (navLink) {
                if (scrollY >= sectionTop && scrollY < sectionTop + sectionHeight) {
                    navLink.classList.add('active');
                } else {
                    navLink.classList.remove('active');
                }
            }
        });
    }

    // ==================== COUNTER ANIMATION ====================
    const counterObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el = entry.target;
                const target = parseInt(el.getAttribute('data-count'), 10);
                animateCounter(el, target);
                counterObserver.unobserve(el);
            }
        });
    }, { threshold: 0.5 });

    document.querySelectorAll('.stat-number[data-count]').forEach(el => {
        counterObserver.observe(el);
    });

    function animateCounter(element, target) {
        const duration = 1500;
        const start = performance.now();

        function step(now) {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            // Ease out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = Math.round(eased * target);
            element.textContent = current;

            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                element.textContent = target;
            }
        }

        requestAnimationFrame(step);
    }

    // ==================== MAGNETIC BUTTONS ====================
    if (cursorGlow && window.matchMedia('(pointer: fine)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.querySelectorAll('.magnetic').forEach(btn => {
            btn.addEventListener('mousemove', (e) => {
                const rect = btn.getBoundingClientRect();
                const x = e.clientX - rect.left - rect.width / 2;
                const y = e.clientY - rect.top - rect.height / 2;
                btn.style.transform = `translate(${x * 0.15}px, ${y * 0.15}px)`;
            });

            btn.addEventListener('mouseleave', () => {
                btn.style.transform = '';
            });
        });
    }

    // ==================== PARALLAX ON HERO ====================
    const heroContent = document.querySelector('.hero-content');
    const heroSection = document.querySelector('.hero');

    function handleParallax() {
        if (!heroSection || !heroContent) return;
        const rect = heroSection.getBoundingClientRect();
        if (rect.bottom < 0) return; // Off screen

        const scrolled = window.scrollY;
        const rate = scrolled * 0.3;
        heroContent.style.transform = `translateY(${rate}px)`;
        heroContent.style.opacity = 1 - (scrolled / (window.innerHeight * 0.8));
    }

    // ==================== SMOOTH SCROLL ====================
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                const navHeight = navbar.offsetHeight;
                const targetPosition = target.offsetTop - navHeight;

                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });

    // ==================== SCROLL HANDLER ====================
    // Combine all scroll listeners into one performant handler
    let ticking = false;

    window.addEventListener('scroll', () => {
        if (!ticking) {
            requestAnimationFrame(() => {
                updateScrollProgress();
                handleNavScroll();
                highlightNavLink();
                handleParallax();
                ticking = false;
            });
            ticking = true;
        }
    }, { passive: true });

    // ==================== PORTFOLIO TABS ====================
    const portfolioTabs = document.querySelectorAll('.portfolio-tab');
    const portfolioCategories = document.querySelectorAll('.portfolio-category');

    portfolioTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const filter = tab.dataset.filter;

            portfolioTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            portfolioCategories.forEach(cat => {
                if (filter === 'all') {
                    cat.classList.remove('hidden');
                } else if (cat.dataset.category === filter) {
                    cat.classList.remove('hidden');
                } else {
                    cat.classList.add('hidden');
                }
            });
        });
    });

    // Initial calls
    updateScrollProgress();
    handleNavScroll();
    highlightNavLink();

})();
