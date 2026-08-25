'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'cc_admin_session';
const SESSION_SECONDS = 8 * 60 * 60;
const attempts = new Map();

function base64url(value) {
    return Buffer.from(value).toString('base64url');
}

function sessionSecret() {
    const value = String(process.env.ADMIN_SESSION_SECRET || '');
    return value.length >= 32 ? value : '';
}

function passwordHash() {
    return String(process.env.ADMIN_PASSWORD_HASH || '');
}

function isConfigured() {
    return Boolean(sessionSecret() && /^scrypt:[A-Za-z0-9_-]{16,}:[A-Za-z0-9_-]{40,}$/.test(passwordHash()));
}

function sign(value) {
    return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function cookieValue(request) {
    const cookies = String(request.headers.cookie || '').split(';');
    for (const cookie of cookies) {
        const [name, ...valueParts] = cookie.trim().split('=');
        if (name === COOKIE_NAME) return valueParts.join('=');
    }
    return '';
}

function requestFingerprint(request) {
    return crypto.createHash('sha256').update(String(request.headers['user-agent'] || '')).digest('base64url').slice(0, 16);
}

function createSessionToken(request) {
    const payload = base64url(JSON.stringify({
        v: 1,
        exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
        nonce: crypto.randomBytes(12).toString('base64url'),
        fp: requestFingerprint(request),
    }));
    return `${payload}.${sign(payload)}`;
}

function isAuthenticated(request) {
    if (!isConfigured()) return false;
    const token = cookieValue(request);
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return false;
    const expected = Buffer.from(sign(payload));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return false;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return data.v === 1
            && Number(data.exp) > Math.floor(Date.now() / 1000)
            && data.fp === requestFingerprint(request);
    } catch {
        return false;
    }
}

function verifyPassword(password) {
    if (!isConfigured() || typeof password !== 'string' || password.length < 12 || password.length > 256) return false;
    const [, saltText, hashText] = passwordHash().split(':');
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function clientKey(request) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || request.socket?.remoteAddress || 'unknown';
}

function loginAllowed(request) {
    const key = clientKey(request);
    const now = Date.now();
    const record = attempts.get(key);
    if (!record || now - record.startedAt > 15 * 60 * 1000) {
        attempts.set(key, { count: 0, startedAt: now });
        return true;
    }
    return record.count < 8;
}

function recordLogin(request, success) {
    const key = clientKey(request);
    if (success) {
        attempts.delete(key);
        return;
    }
    const now = Date.now();
    const record = attempts.get(key);
    if (!record || now - record.startedAt > 15 * 60 * 1000) {
        attempts.set(key, { count: 1, startedAt: now });
    } else {
        record.count += 1;
    }
}

function setSessionCookie(response, request) {
    response.setHeader('Set-Cookie', `${COOKIE_NAME}=${createSessionToken(request)}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`);
}

function clearSessionCookie(response) {
    response.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`);
}

module.exports = {
    clearSessionCookie,
    isAuthenticated,
    isConfigured,
    loginAllowed,
    recordLogin,
    setSessionCookie,
    verifyPassword,
};
