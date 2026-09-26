'use strict';
/**
 * Foot du vendredi — serveur HTTP sans dépendance externe.
 * Node ≥ 22.13 (utilise le module intégré node:sqlite).
 *
 *   PORT            port d'écoute (défaut 3000)
 *   DATA_DIR        dossier de la base SQLite (défaut ./data) — à placer sur un volume persistant
 *   ADMIN_PASSWORD  mot de passe admin au premier démarrage (défaut « foot2026 », modifiable dans Réglages)
 *   SEED_DEMO       « 0 » pour ne pas créer les données de démonstration
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, seedDemo, getSetting, setSetting } = require('./src/db');
const { createRepo, AppError } = require('./src/repo');
const { createAuth } = require('./src/auth');
const { today } = require('./src/dates');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

function createApp({ dbFile = path.join(DATA_DIR, 'foot.sqlite'), seed = process.env.SEED_DEMO !== '0' } = {}) {
  const db = openDatabase(dbFile);
  if (seed) seedDemo(db);
  const repo = createRepo(db);
  const auth = createAuth(db);

  /* ---------- Petits utilitaires HTTP ---------- */

  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  };

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    const payload = isJson ? JSON.stringify(body) : body;
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(payload);
  }

  function readJson(req, limit = 32 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new AppError(413, 'too_large', 'Requête trop volumineuse.'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch {
          reject(new AppError(400, 'bad_json', 'Requête invalide.'));
        }
      });
      req.on('error', reject);
    });
  }

  function cookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function isHttps(req) {
    return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  function sessionCookie(req, value, maxAge) {
    return `${auth.COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  }

  function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  }

  // Limiteur en mémoire (fenêtre glissante simple)
  function rateLimiter(max, windowMs) {
    const hits = new Map();
    // peek = vérifier sans compter
    return (key, peek = false) => {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (peek) return arr.length < max;
      arr.push(now);
      hits.set(key, arr);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      return arr.length <= max;
    };
  }
  const registerLimit = rateLimiter(20, 10 * 60 * 1000);
  const codeFailLimit = rateLimiter(8, 60 * 60 * 1000);   // essais de code joueur erronés
  const loginLimit = rateLimiter(10, 15 * 60 * 1000);

  // Cookie « téléphone reconnu » : aléatoire, HttpOnly, seule son empreinte est stockée en base.
  const DEVICE_COOKIE = 'fdv_player';
  const deviceCookie = (req, value, maxAge) =>
    `${DEVICE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

  /* ---------- Routes ---------- */

  const routes = [];
  const route = (method, pattern, handler, { admin = false } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return k === 'token' ? '([A-Za-z0-9_-]{1,100})' : '(\\d+)';
    }) + '$');
    routes.push({ method, re, keys, handler, admin });
  };

  // --- Public (joueurs) ---
  // Lien général : informations du prochain match uniquement (aucune inscription possible sans lien de phase).
  route('GET', '/api/public/match', ({ devicePlayerId }) => repo.currentPublicMatch(devicePlayerId));
  route('GET', '/api/public/matches/:id', ({ params, devicePlayerId }) => repo.publicMatch(params.id, devicePlayerId));

  // Lien d'inscription (Prioritaires / Ouvert / Invitations)
  route('GET', '/api/public/links/:token', ({ params, devicePlayerId }) => repo.publicLink(params.token, devicePlayerId));

  route('POST', '/api/public/matches/:id/registrations', async ({ req, params, body, devicePlayerId }) => {
    const ip = clientIp(req);
    if (!registerLimit(ip)) throw new AppError(429, 'rate_limited', 'Trop de tentatives, réessaie dans quelques minutes.');
    if (body.player_code && !codeFailLimit(`peek:${ip}`, true)) {
      throw new AppError(429, 'rate_limited', 'Trop de codes incorrects. Réessaie plus tard ou contacte l’organisateur.');
    }
    let out;
    try {
      out = repo.registerPublic(params.id, body, { devicePlayerId });
    } catch (e) {
      if (e instanceof AppError && e.extra && e.extra.code_failed) codeFailLimit(`peek:${ip}`);
      throw e;
    }
    const headers = {};
    // Le téléphone retient le joueur (sauf quand on inscrit quelqu'un d'autre)
    if (body.as_other !== true && out.player_id !== devicePlayerId) {
      headers['Set-Cookie'] = deviceCookie(req, repo.issueDevice(out.player_id), 400 * 86400);
    }
    delete out.player_id;
    return [201, out, headers];
  });

  // « Ce n'est pas moi » : le téléphone oublie le joueur
  route('POST', '/api/public/forget', ({ req, deviceToken }) => {
    repo.forgetDevice(deviceToken);
    return [200, { ok: true }, { 'Set-Cookie': deviceCookie(req, '', 0) }];
  });

  // --- Administration ---
  route('POST', '/api/admin/login', async ({ req, body }) => {
    if (!loginLimit(clientIp(req))) throw new AppError(429, 'rate_limited', 'Trop de tentatives, réessaie dans 15 minutes.');
    const pw = String(body.password || '');
    const token = pw.length <= 200 ? auth.login(pw) : null;
    if (!token) throw new AppError(401, 'bad_password', 'Mot de passe incorrect.');
    return [200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, auth.maxAge) }];
  });

  route('POST', '/api/admin/logout', ({ req }) => [200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) }]);

  route('GET', '/api/admin/session', ({ isAdmin }) => ({ authenticated: isAdmin }));

  route('GET', '/api/admin/overview', () => ({
    current: repo.currentAdminMatch(),
    next_defaults: repo.nextDefaults(),
    season: repo.currentSeason(),
    warnings: {
      default_password: auth.isDefaultPassword(),
      missing_payment_link: !getSetting(db, 'default_payment_link', ''),
      has_demo: repo.hasDemo(),
    },
  }), { admin: true });

  route('GET', '/api/admin/matches', () => ({ matches: repo.listMatches() }), { admin: true });
  route('GET', '/api/admin/matches/next-defaults', () => ({ defaults: repo.nextDefaults() }), { admin: true });
  route('POST', '/api/admin/matches', ({ body }) => [201, repo.createMatch(body)], { admin: true });
  route('GET', '/api/admin/matches/:id', ({ params }) => repo.adminMatch(params.id), { admin: true });
  route('PATCH', '/api/admin/matches/:id', ({ params, body }) => repo.updateMatch(params.id, body), { admin: true });
  route('DELETE', '/api/admin/matches/:id', ({ params }) => (repo.deleteMatch(params.id), { ok: true }), { admin: true });
  route('POST', '/api/admin/matches/:id/links/regenerate', ({ params }) => repo.regenerateLinks(params.id), { admin: true });

  route('POST', '/api/admin/matches/:id/registrations', ({ params, body }) => [201, repo.registerAdmin(params.id, body)], { admin: true });
  route('PATCH', '/api/admin/registrations/:id', ({ params, body }) => repo.updateRegistration(params.id, body), { admin: true });
  route('DELETE', '/api/admin/registrations/:id', ({ params }) => repo.deleteRegistration(params.id), { admin: true });

  // Joueurs
  route('GET', '/api/admin/players', () => ({ players: repo.listPlayers(), season: repo.currentSeason(), threshold: repo.LOYALTY_THRESHOLD }), { admin: true });
  route('POST', '/api/admin/players', ({ body }) => [201, repo.createPlayerAdmin(body)], { admin: true });
  route('GET', '/api/admin/players/:id', ({ params }) => repo.playerDetail(params.id), { admin: true });
  route('PATCH', '/api/admin/players/:id', ({ params, body }) => repo.updatePlayer(params.id, body), { admin: true });
  route('DELETE', '/api/admin/players/:id', ({ params }) => (repo.deletePlayer(params.id), { ok: true }), { admin: true });
  route('POST', '/api/admin/players/:id/merge', ({ params, body }) => repo.mergePlayers(params.id, Number(body.into_player_id)), { admin: true });

  // Saisons
  route('GET', '/api/admin/seasons', () => ({ seasons: repo.listSeasons() }), { admin: true });
  route('POST', '/api/admin/seasons', ({ body }) => [201, { seasons: repo.startSeason(body) }], { admin: true });

  route('GET', '/api/admin/settings', () => ({
    default_payment_link: getSetting(db, 'default_payment_link', ''),
    default_password: auth.isDefaultPassword(),
    has_demo: repo.hasDemo(),
    seasons: repo.listSeasons(),
  }), { admin: true });

  route('PATCH', '/api/admin/settings', ({ body }) => {
    if (body.default_payment_link !== undefined) {
      const l = String(body.default_payment_link).trim();
      if (l && !/^https?:\/\/\S+$/i.test(l)) throw new AppError(400, 'invalid_link', 'Le lien de paiement doit commencer par https://');
      if (l.length > 500) throw new AppError(400, 'invalid_link', 'Lien de paiement trop long.');
      setSetting(db, 'default_payment_link', l);
      // Applique le nouveau lien aux matchs à venir.
      if (body.apply_to_upcoming) {
        db.prepare('UPDATE matches SET payment_link = ? WHERE date >= ?').run(l, today());
      }
    }
    return { ok: true, default_payment_link: getSetting(db, 'default_payment_link', '') };
  }, { admin: true });

  route('POST', '/api/admin/password', ({ req, body }) => {
    const r = auth.changePassword(String(body.current || '').slice(0, 200), typeof body.next === 'string' && body.next.length <= 200 ? body.next : '');
    if (!r.ok) throw new AppError(400, 'bad_password', r.error);
    return [200, { ok: true }, { 'Set-Cookie': sessionCookie(req, r.token, auth.maxAge) }];
  }, { admin: true });

  route('POST', '/api/admin/demo/clear', () => ({ ok: true, deleted: repo.clearDemo() }), { admin: true });

  /* ---------- Fichiers statiques ---------- */

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
    '.ico': 'image/x-icon',
  };
  const PAGES = { '/': 'index.html', '/admin': 'admin.html', '/admin/': 'admin.html' };

  function serveStatic(req, res, pathname) {
    let rel = PAGES[pathname] || (/^\/(m\/\d+|i\/[A-Za-z0-9_-]{1,100})$/.test(pathname) ? 'index.html' : pathname.slice(1));
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Page introuvable');
      const ext = path.extname(file);
      send(res, 200, data, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      });
    });
  }

  /* ---------- Dispatcher ---------- */

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/healthz') return send(res, 200, { ok: true });

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, pathname);
    }

    try {
      const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
      if (!r) throw new AppError(404, 'not_found', 'Ressource introuvable.');
      const m = pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const jar = cookies(req);
      const isAdmin = auth.check(jar[auth.COOKIE]);
      const deviceToken = jar[DEVICE_COOKIE] || null;
      const devicePlayerId = repo.playerFromDevice(deviceToken);
      if (r.admin && !isAdmin) throw new AppError(401, 'unauthorized', 'Connexion requise.');

      // Protection CSRF : les écritures doivent être des requêtes JSON émises par nos pages.
      let body = {};
      if (req.method !== 'GET') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new AppError(415, 'bad_content_type', 'Requête invalide.');
        }
        body = await readJson(req);
      }

      const out = await r.handler({ req, res, url, params, body, isAdmin, deviceToken, devicePlayerId });
      if (Array.isArray(out)) send(res, out[0], out[1], out[2]);
      else send(res, 200, out);
    } catch (e) {
      if (e instanceof AppError) return send(res, e.status, { error: e.code, message: e.message, ...e.extra });
      console.error(e);
      send(res, 500, { error: 'server_error', message: 'Erreur serveur, réessaie.' });
    }
  };
}

if (require.main === module) {
  const handler = createApp();
  http.createServer(handler).listen(PORT, () => {
    console.log(`⚽ Foot du vendredi prêt sur http://localhost:${PORT}`);
    console.log(`   Admin : http://localhost:${PORT}/admin`);
  });
}

module.exports = { createApp };
