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

function createAuth(db) {
  // Secret de signature des sessions, généré une fois et conservé en base.
  let secret = getSetting(db, 'session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting(db, 'session_secret', secret);
  }
  // Mot de passe initial : variable d'environnement ADMIN_PASSWORD, sinon valeur provisoire.
  // RESET_ADMIN_PASSWORD=1 permet de repartir de ADMIN_PASSWORD en cas d'oubli.
  if (!getSetting(db, 'admin_password_hash') || process.env.RESET_ADMIN_PASSWORD === '1') {
    setSetting(db, 'admin_password_hash', hashPassword(process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD));
    setSetting(db, 'admin_password_is_default', process.env.ADMIN_PASSWORD ? '0' : '1');
    setSetting(db, 'session_version', String(Number(getSetting(db, 'session_version', '0')) + 1));
  }

  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  function issue() {
    const payload = b64(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 864e5, v: getSetting(db, 'session_version', '1') }));
    return `${payload}.${sign(payload)}`;
  }

  function check(cookieValue) {
    if (!cookieValue || !cookieValue.includes('.')) return false;
    const [payload, sig] = cookieValue.split('.');
    const expected = sign(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return data.exp > Date.now() && data.v === getSetting(db, 'session_version', '1');
    } catch {
      return false;
    }
  }

  return {
    COOKIE,
    maxAge: SESSION_DAYS * 86400,
    login(password) {
      return verifyPassword(password, getSetting(db, 'admin_password_hash')) ? issue() : null;
    },
    check,
    isDefaultPassword: () => getSetting(db, 'admin_password_is_default') === '1',
    changePassword(current, next) {
      if (!verifyPassword(current, getSetting(db, 'admin_password_hash'))) return { ok: false, error: 'Mot de passe actuel incorrect.' };
      if (typeof next !== 'string' || next.length < 10) return { ok: false, error: 'Le nouveau mot de passe doit faire au moins 10 caractères.' };
      setSetting(db, 'admin_password_hash', hashPassword(next));
      setSetting(db, 'admin_password_is_default', '0');
      // Invalide toutes les autres sessions
      setSetting(db, 'session_version', String(Number(getSetting(db, 'session_version', '1')) + 1));
      return { ok: true, token: issue() };
    },
  };
}

module.exports = { createAuth };
