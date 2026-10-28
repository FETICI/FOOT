'use strict';
const crypto = require('node:crypto');
const { getSetting, setSetting } = require('./db');

const COOKIE = 'fdv_admin';
const SESSION_DAYS = 30;
const DEFAULT_PASSWORD = 'foot2026';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const b64 = (s) => Buffer.from(s).toString('base64url');

async function createAuth(pool) {
  // Secret de signature des sessions, généré une fois et conservé en base.
  let secret = await getSetting(pool, 'session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    await setSetting(pool, 'session_secret', secret);
  }
  // Mot de passe initial
  if (!await getSetting(pool, 'admin_password_hash') || process.env.RESET_ADMIN_PASSWORD === '1') {
    await setSetting(pool, 'admin_password_hash', hashPassword(process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD));
    await setSetting(pool, 'admin_password_is_default', process.env.ADMIN_PASSWORD ? '0' : '1');
    const v = await getSetting(pool, 'session_version', '0');
    await setSetting(pool, 'session_version', String(Number(v) + 1));
  }

  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  async function issue() {
    const v = await getSetting(pool, 'session_version', '1');
    const payload = b64(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 864e5, v }));
    return `${payload}.${sign(payload)}`;
  }

  async function check(cookieValue) {
    if (!cookieValue || !cookieValue.includes('.')) return false;
    const [payload, sig] = cookieValue.split('.');
    const expected = sign(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const v = await getSetting(pool, 'session_version', '1');
      return data.exp > Date.now() && data.v === v;
    } catch {
      return false;
    }
  }

  return {
    COOKIE,
    maxAge: SESSION_DAYS * 86400,
    async login(password) {
      const hash = await getSetting(pool, 'admin_password_hash');
      return verifyPassword(password, hash) ? issue() : null;
    },
    check,
    async isDefaultPassword() {
      return (await getSetting(pool, 'admin_password_is_default')) === '1';
    },
    async changePassword(current, next) {
      const hash = await getSetting(pool, 'admin_password_hash');
      if (!verifyPassword(current, hash)) return { ok: false, error: 'Mot de passe actuel incorrect.' };
      if (typeof next !== 'string' || next.length < 10) return { ok: false, error: 'Le nouveau mot de passe doit faire au moins 10 caractères.' };
      await setSetting(pool, 'admin_password_hash', hashPassword(next));
      await setSetting(pool, 'admin_password_is_default', '0');
      const v = await getSetting(pool, 'session_version', '1');
      await setSetting(pool, 'session_version', String(Number(v) + 1));
      return { ok: true, token: await issue() };
    },
  };
}

module.exports = { createAuth };
