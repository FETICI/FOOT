'use strict';
/**
 * Foot du vendredi — serveur HTTP.
 *
 *   PORT            port d'écoute (défaut 3000)
 *   DATABASE_URL    URL de connexion PostgreSQL (Railway l'injecte automatiquement)
 *   ADMIN_PASSWORD  mot de passe admin au premier démarrage (défaut « foot2026 »)
 *   SEED_DEMO       « 0 » pour ne pas créer les données de démonstration
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, seedDemo, getSetting, setSetting } = require('./src/db');
const { createRepo, AppError, PAYMENT_LINK_AMOUNTS } = require('./src/repo');
const { createAuth } = require('./src/auth');
const { createTeamsRepo } = require('./src/teams');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

async function createApp({ seed = process.env.SEED_DEMO !== '0' } = {}) {
  const pool = await openDatabase();
  if (seed) await seedDemo(pool).catch((e) => console.error('[seed] erreur:', e.message));
  const repo = createRepo(pool);
  const auth = await createAuth(pool);
  const teams = createTeamsRepo(pool);

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
    return (key) => {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      arr.push(now);
      hits.set(key, arr);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      return arr.length <= max;
    };
  }
  const registerLimit = rateLimiter(20, 10 * 60 * 1000);
  const lookupLimit = rateLimiter(30, 10 * 60 * 1000);
  const loginLimit = rateLimiter(10, 15 * 60 * 1000);

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
  route('GET', '/api/public/match', () => repo.currentPublicMatch());
  route('GET', '/api/public/matches/:id', ({ params }) => repo.publicMatch(params.id));
  route('GET', '/api/public/links/:token', ({ params }) => repo.publicLink(params.token));

  route('POST', '/api/public/matches/:id/registrations', async ({ req, params, body }) => {
    if (!registerLimit(clientIp(req))) throw new AppError(429, 'rate_limited', 'Trop de tentatives, réessaie dans quelques minutes.');
    return [201, await repo.registerPublic(params.id, body)];
  });

  route('POST', '/api/public/matches/:id/lookup', async ({ req, params, body }) => {
    if (!lookupLimit(clientIp(req))) throw new AppError(429, 'rate_limited', 'Trop de tentatives, réessaie dans quelques minutes.');
    return repo.lookupPublic(params.id, body);
  });

  // --- Administration ---
  route('POST', '/api/admin/login', async ({ req, body }) => {
    if (!loginLimit(clientIp(req))) throw new AppError(429, 'rate_limited', 'Trop de tentatives, réessaie dans 15 minutes.');
    const pw = String(body.password || '');
    const token = pw.length <= 200 ? await auth.login(pw) : null;
    if (!token) throw new AppError(401, 'bad_password', 'Mot de passe incorrect.');
    return [200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, auth.maxAge) }];
  });

  route('POST', '/api/admin/logout', ({ req }) => [200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) }]);
  route('GET', '/api/admin/session', ({ isAdmin }) => ({ authenticated: isAdmin }));

  route('GET', '/api/admin/overview', async () => {
    const [current, next_defaults, season, players, defaultPassword, hasDemo] = await Promise.all([
      repo.currentAdminMatch(),
      repo.nextDefaults(),
      repo.currentSeason(),
      repo.listPlayers(),
      auth.isDefaultPassword(),
      repo.hasDemo(),
    ]);
    const cardLinkMissing = await Promise.all(PAYMENT_LINK_AMOUNTS.map(async (c) => !(await repo.paymentLinkFor(c))));
    return {
      current,
      next_defaults,
      season,
      warnings: {
        default_password: defaultPassword,
        missing_card_links: PAYMENT_LINK_AMOUNTS.filter((_, i) => cardLinkMissing[i]),
        has_demo: hasDemo,
        players_to_review: players.filter((p) => p.needs_review).length,
        subscribers_without_phone: players.filter((p) => p.subscriber && p.missing_phone).length,
      },
    };
  }, { admin: true });

  route('GET', '/api/admin/matches', async () => ({ matches: await repo.listMatches() }), { admin: true });
  route('GET', '/api/admin/matches/next-defaults', async () => ({ defaults: await repo.nextDefaults() }), { admin: true });
  route('POST', '/api/admin/matches', async ({ body }) => [201, await repo.createMatch(body)], { admin: true });
  route('GET', '/api/admin/matches/:id', async ({ params }) => repo.adminMatch(params.id), { admin: true });
  route('PATCH', '/api/admin/matches/:id', async ({ params, body }) => repo.updateMatch(params.id, body), { admin: true });
  route('DELETE', '/api/admin/matches/:id', async ({ params }) => { await repo.deleteMatch(params.id); return { ok: true }; }, { admin: true });
  route('POST', '/api/admin/matches/:id/links/regenerate', async ({ params }) => repo.regenerateLinks(params.id), { admin: true });

  route('POST', '/api/admin/matches/:id/registrations', async ({ params, body }) => [201, await repo.registerAdmin(params.id, body)], { admin: true });
  route('PATCH', '/api/admin/registrations/:id', async ({ params, body }) => repo.updateRegistration(params.id, body), { admin: true });
  route('DELETE', '/api/admin/registrations/:id', async ({ params }) => repo.deleteRegistration(params.id), { admin: true });

  // Joueurs
  route('GET', '/api/admin/players', async () => {
    const [players, season] = await Promise.all([repo.listPlayers(), repo.currentSeason()]);
    return { players, season, threshold: repo.LOYALTY_THRESHOLD };
  }, { admin: true });
  route('POST', '/api/admin/players', async ({ body }) => [201, await repo.createPlayerAdmin(body)], { admin: true });
  route('GET', '/api/admin/players/:id', async ({ params }) => repo.playerDetail(params.id), { admin: true });
  route('PATCH', '/api/admin/players/:id', async ({ params, body }) => repo.updatePlayer(params.id, body), { admin: true });
  route('DELETE', '/api/admin/players/:id', async ({ params }) => { await repo.deletePlayer(params.id); return { ok: true }; }, { admin: true });
  route('POST', '/api/admin/players/:id/merge', async ({ params, body }) =>
    repo.mergePlayers(params.id, Number(body.into_player_id), { phoneFrom: body.phone_from === 'source' ? 'source' : 'target' }),
    { admin: true });

  // Saisons
  route('GET', '/api/admin/seasons', async () => ({ seasons: await repo.listSeasons() }), { admin: true });
  route('POST', '/api/admin/seasons', async ({ body }) => [201, { seasons: await repo.startSeason(body) }], { admin: true });

  // Réglages
  route('GET', '/api/admin/settings', async () => {
    const [links, legacyLink, defaultPassword, hasDemo, seasons] = await Promise.all([
      Promise.all(PAYMENT_LINK_AMOUNTS.map(async (c) => [c, await getSetting(pool, `payment_link_${c}`, '')])),
      getSetting(pool, 'default_payment_link', ''),
      auth.isDefaultPassword(),
      repo.hasDemo(),
      repo.listSeasons(),
    ]);
    return {
      payment_links: Object.fromEntries(links),
      legacy_payment_link: legacyLink,
      default_password: defaultPassword,
      has_demo: hasDemo,
      seasons,
    };
  }, { admin: true });

  route('PATCH', '/api/admin/settings', async ({ body }) => {
    const linkMap = body.payment_links && typeof body.payment_links === 'object' ? body.payment_links : {};
    const next = {};
    for (const c of PAYMENT_LINK_AMOUNTS) {
      const existing = await getSetting(pool, `payment_link_${c}`, '');
      const l = linkMap[c] === undefined ? existing : String(linkMap[c]).trim();
      if (l && !/^https:\/\/\S+$/i.test(l)) throw new AppError(400, 'invalid_link', `Le lien ${c / 100} € doit commencer par https://`);
      if (l.length > 500) throw new AppError(400, 'invalid_link', 'Lien de paiement trop long.');
      next[c] = l;
    }
    const vals = Object.values(next).filter(Boolean);
    if (new Set(vals).size !== vals.length) throw new AppError(400, 'same_link', 'Les liens 5 € et 10 € doivent être différents.');
    await Promise.all(PAYMENT_LINK_AMOUNTS.map((c) => setSetting(pool, `payment_link_${c}`, next[c])));
    const updated = await Promise.all(PAYMENT_LINK_AMOUNTS.map(async (c) => [c, await getSetting(pool, `payment_link_${c}`, '')]));
    return { ok: true, payment_links: Object.fromEntries(updated) };
  }, { admin: true });

  route('POST', '/api/admin/password', async ({ req, body }) => {
    const r = await auth.changePassword(
      String(body.current || '').slice(0, 200),
      typeof body.next === 'string' && body.next.length <= 200 ? body.next : ''
    );
    if (!r.ok) throw new AppError(400, 'bad_password', r.error);
    return [200, { ok: true }, { 'Set-Cookie': sessionCookie(req, r.token, auth.maxAge) }];
  }, { admin: true });

  route('POST', '/api/admin/demo/clear', async () => ({ ok: true, deleted: await repo.clearDemo() }), { admin: true });

  // --- Équipes ---
  route('GET', '/api/admin/matches/:id/teams', async ({ params }) => {
    const data = await teams.getTeams(params.id);
    return { teams: data ? data.data : null };
  }, { admin: true });

  // body: { teams: [...] }
  route('POST', '/api/admin/matches/:id/teams', async ({ params, body }) => {
    const saved = await teams.saveTeams(params.id, Array.isArray(body.teams) ? body.teams : []);
    return [201, { teams: saved.data }];
  }, { admin: true });

  route('PATCH', '/api/admin/matches/:id/teams', async ({ params, body }) => {
    const saved = await teams.updateTeams(params.id, Array.isArray(body.teams) ? body.teams : []);
    return { teams: saved.data };
  }, { admin: true });

  route('DELETE', '/api/admin/matches/:id/teams', async ({ params }) => {
    await teams.deleteTeams(params.id);
    return { ok: true };
  }, { admin: true });

  route('POST', '/api/admin/matches/:id/teams/draw', async ({ params, body }) => {
    const matchView = await repo.adminMatch(params.id);
    const playerNames = Array.isArray(body.players) && body.players.length
      ? body.players
      : matchView.registrations.map((r) => r.first_name);
    const numTeams = Math.max(2, Math.min(10, Number(body.num_teams) || 2));
    const drawn = teams.drawTeams(playerNames, numTeams);
    return { teams: drawn };
  }, { admin: true });

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
      const isAdmin = await auth.check(cookies(req)[auth.COOKIE]);
      if (r.admin && !isAdmin) throw new AppError(401, 'unauthorized', 'Connexion requise.');

      // Protection CSRF : les écritures doivent être des requêtes JSON émises par nos pages.
      let body = {};
      if (req.method !== 'GET') {
        const ct = String(req.headers['content-type'] || '');
        if (!ct.startsWith('application/json')) throw new AppError(415, 'bad_content_type', 'Requête invalide.');
        body = await readJson(req);
      }

      const out = await r.handler({ req, res, url, params, body, isAdmin });
      if (Array.isArray(out)) send(res, out[0], out[1], out[2]);
      else send(res, 200, out);
    } catch (e) {
      if (e instanceof AppError || (e && e.status)) return send(res, e.status, { error: e.code, message: e.message, ...e.extra });
      console.error(e);
      send(res, 500, { error: 'server_error', message: 'Erreur serveur, réessaie.' });
    }
  };
}

if (require.main === module) {
  createApp().then((handler) => {
    http.createServer(handler).listen(PORT, () => {
      console.log(`⚽ Foot du vendredi prêt sur http://localhost:${PORT}`);
      console.log(`   Admin : http://localhost:${PORT}/admin`);
    });
  }).catch((e) => {
    console.error('Impossible de démarrer :', e.message);
    process.exit(1);
  });
}

module.exports = { createApp };
