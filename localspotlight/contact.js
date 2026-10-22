'use strict';

window.CerneySelectsPhone = value => {
    const original = typeof value === 'string' ? value.trim().slice(0, 40) : '';
    const dial = original.replace(/[^+\d]/g, '');
    const valid = /^[+\d().\-\s]+$/.test(original) && /^\+?\d{7,15}$/.test(dial);
    if (!valid) return { display: original, href: '' };
    const digits = dial.replace(/^\+/, '');
    const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (local.length === 10 && (!dial.startsWith('+') || (digits.length === 11 && digits.startsWith('1')))) {
        return { display: `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`, href: `tel:+1${local}` };
    }
    return { display: original, href: `tel:${dial}` };
};
