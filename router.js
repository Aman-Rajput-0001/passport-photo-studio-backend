const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const COOKIE_NAME = 'admin_session';

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try { cookies[key] = decodeURIComponent(value); } catch { /* ignore malformed cookies */ }
    }
  }
  return cookies;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyPassword(password, encodedHash) {
  try {
    const parts = String(encodedHash || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || N < 16384 || N > 1048576 || (N & (N - 1)) !== 0) return false;
    if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 8) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (salt.length < 16 || expected.length < 32 || expected.length > 128) return false;
    const actual = crypto.scryptSync(String(password || ''), salt, expected.length, {
      N, r, p, maxmem: Math.max(32 * 1024 * 1024, 128 * N * r + 1024),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function createAdminRouter({ basePath, listUploads, getLogs, getSiteState, setSiteState, secureCookies }) {
  const router = express.Router();
  const sessions = new Map();
  const loginAttempts = new Map();
  const adminUsername = process.env.ADMIN_USERNAME;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  const adminDir = path.join(__dirname);
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(id);
    }
    for (const [key, entry] of loginAttempts) {
      if (entry.windowStarted + LOGIN_WINDOW_MS < now && (!entry.lockedUntil || entry.lockedUntil < now)) {
        loginAttempts.delete(key);
      }
    }
  }, 10 * 60 * 1000);
  cleanupTimer.unref();

  router.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  function cookieOptions() {
    return `Path=/; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}`;
  }

  function issueSession(res) {
    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, {
      username: adminUsername,
      csrfToken: crypto.randomBytes(32).toString('base64url'),
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(id)}; Max-Age=${SESSION_TTL_MS / 1000}; ${cookieOptions()}`);
    return sessions.get(id);
  }

  function getSession(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = id && sessions.get(id);
    if (!session) return null;
    if (Date.now() - session.lastSeen > SESSION_TTL_MS || Date.now() - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
      return null;
    }
    session.lastSeen = Date.now();
    return { id, value: session };
  }

  function requireSession(req, res, next) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Admin authentication required' });
    req.adminSession = session;
    next();
  }

  function requireCsrf(req, res, next) {
    const supplied = req.get('X-CSRF-Token') || (req.body && req.body.csrfToken);
    if (!req.adminSession || !safeEqual(supplied, req.adminSession.value.csrfToken)) {
      return res.status(403).json({ error: 'CSRF validation failed' });
    }
    next();
  }

  function loginKey(req, username) {
    return `${req.ip || 'unknown'}:${String(username || '').slice(0, 128).toLowerCase()}`;
  }

  function isLocked(key) {
    const entry = loginAttempts.get(key);
    if (!entry) return false;
    if (entry.lockedUntil && entry.lockedUntil > Date.now()) return true;
    if (entry.windowStarted + LOGIN_WINDOW_MS < Date.now()) {
      loginAttempts.delete(key);
      return false;
    }
    return false;
  }

  function recordFailure(key) {
    const now = Date.now();
    const entry = loginAttempts.get(key);
    if (!entry || entry.windowStarted + LOGIN_WINDOW_MS < now) {
      loginAttempts.set(key, { count: 1, windowStarted: now, lockedUntil: 0 });
      return;
    }
    entry.count += 1;
    if (entry.count >= LOGIN_MAX_ATTEMPTS) entry.lockedUntil = now + LOCKOUT_MS;
  }

  router.use(express.json({ limit: '20kb' }));

  router.get('/', (req, res) => {
    res.sendFile(path.join(adminDir, 'index.html'));
  });
  router.get('/app.js', (req, res) => res.sendFile(path.join(adminDir, 'app.js')));
  router.get('/style.css', (req, res) => res.sendFile(path.join(adminDir, 'style.css')));

  router.post('/api/login', (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const key = loginKey(req, username);
    if (isLocked(key)) return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });

    const valid = Boolean(adminUsername && passwordHash && safeEqual(username, adminUsername)
      && verifyPassword(password, passwordHash));
    if (!valid) {
      recordFailure(key);
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    loginAttempts.delete(key);
    const session = issueSession(res);
    res.json({ ok: true, csrfToken: session.csrfToken, username: session.username });
  });

  router.get('/api/session', requireSession, (req, res) => {
    res.json({ authenticated: true, csrfToken: req.adminSession.value.csrfToken, username: req.adminSession.value.username });
  });

  router.post('/api/logout', requireSession, requireCsrf, (req, res) => {
    sessions.delete(req.adminSession.id);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; ${cookieOptions()}`);
    res.json({ ok: true });
  });

  router.get('/api/uploads', requireSession, (req, res) => {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
    res.json({ uploads: listUploads(limit) });
  });

  router.get('/api/logs', requireSession, (req, res) => {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 200;
    res.json({ logs: getLogs(limit) });
  });

  router.get('/api/site-state', requireSession, (req, res) => {
    res.json(getSiteState());
  });

  router.post('/api/site-state', requireSession, requireCsrf, (req, res) => {
    if (typeof req.body?.maintenance !== 'boolean' || typeof req.body?.message !== 'string') {
      return res.status(400).json({ error: 'maintenance must be boolean and message must be text' });
    }
    const message = req.body.message.trim().slice(0, 500);
    const state = setSiteState({ maintenance: req.body.maintenance, message });
    res.json(state);
  });

  return router;
}

module.exports = { createAdminRouter, verifyPassword };
