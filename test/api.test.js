'use strict';
// Tests d'intégration : `npm test`
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.ADMIN_PASSWORD = 'secret-test-password';
const { createApp } = require('../server');
const { openDatabase, seedDemo, createPlayer, currentSeasonId, ensureMatchLinks } = require('../src/db');
const { normalizePhone } = require('../src/phone');

/* =========================================================
   Outils
   ========================================================= */

async function startServer({ dbFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdv-'));
  const server = http.createServer(createApp({ dbFile: dbFile || path.join(dir, 'test.sqlite'), seed: true }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Un « navigateur » avec son propre pot de cookies. */
  function client() {
    const jar = {};
    const call = async (method, url, body) => {
      const cookie = Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(base + url, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const c of res.headers.getSetCookie()) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        jar[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const text = await res.text();
      let json = {};
      try { json = JSON.parse(text); } catch { /* non JSON */ }
      return { status: res.status, body: json, text, headers: res.headers };
    };
    return { call, jar };
  }

  const admin = client();
  const login = await admin.call('POST', '/api/admin/login', { password: 'secret-test-password' });
  assert.equal(login.status, 200);
  return { server, client, admin: admin.call, base };
}

async function setup(t, opts) {
  const ctx = await startServer(opts);
  t.after(() => ctx.server.close());
  const { admin } = ctx;
  const players = (await admin('GET', '/api/admin/players')).body.players;
  const P = (name) => players.find((p) => p.first_name === name);
  const current = (await admin('GET', '/api/admin/overview')).body.current;
  return { ...ctx, P, current };
}

/** Crée un match de test (phase donnée) et renvoie sa vue admin. */
async function newMatch(admin, over = {}) {
  const r = await admin('POST', '/api/admin/matches', {
    date: '2099-06-05', time: '20:00', location: 'Test', price_cents: 1000, subscriber_price_cents: 500, capacity: 20, status: 'priority', ...over,
  });
  assert.equal(r.status, 201);
  return r.body;
}

const tokenOf = (m, level) => m.links.find((l) => l.level === level).token;
const reg = (c, matchId, body) => c.call('POST', `/api/public/matches/${matchId}/registrations`, { payment_method: 'card', ...body });

// Numéros de test uniques (plage fictive 06 39 98 5x xx)
let seq = 5000;
const freshPhone = () => `06 39 98 ${String(++seq).slice(0, 2)} ${String(seq).slice(2, 4)}`;

/* =========================================================
   Normalisation des numéros
   ========================================================= */

test('téléphone : les différentes écritures d’un même numéro sont identiques', () => {
  const same = ['0612345678', '06 12 34 56 78', '06.12.34.56.78', '06-12-34-56-78', '+33 6 12 34 56 78', '+33612345678', '0033 6 12 34 56 78', '+33 (0)6 12 34 56 78'.replace('(0)', '0')];
  for (const s of same) assert.equal(normalizePhone(s), '+33612345678', s);
  assert.equal(normalizePhone('+44 7911 123456'), '+447911123456');
  assert.equal(normalizePhone('0044 7911 123456'), '+447911123456');
  for (const bad of ['', '123', '612345678', 'abc', '06 12 34', '+33 1 2', '06 12 34 56 78 90', '<script>']) {
    assert.equal(normalizePhone(bad), null, bad);
  }
});

/* =========================================================
   Accès / phases
   ========================================================= */

test('phases : chaque lien n’est actif qu’à partir de sa phase', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'priority' });
  const id = m.match.id;
  const tok = { priority: tokenOf(m, 'priority'), open: tokenOf(m, 'open'), invite: tokenOf(m, 'invite') };
  const thomas = { first_name: 'Thomas', phone: P('Thomas').phone };

  const phone = client();
  assert.equal((await phone.call('GET', `/api/public/links/${tok.open}`)).body.state, 'not_open');
  assert.equal((await phone.call('GET', `/api/public/links/${tok.invite}`)).body.state, 'not_open');
  let r = await reg(phone, id, { link_token: tok.open, ...thomas });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'not_open');
  assert.equal(r.body.message, 'Les inscriptions ne sont pas encore ouvertes pour ce lien.');
  r = await reg(phone, id, { link_token: tok.invite, ...thomas });
  assert.equal(r.body.error, 'not_open');

  assert.equal((await phone.call('GET', `/api/public/links/${tok.priority}`)).body.state, 'open');
  r = await reg(phone, id, { link_token: tok.priority, ...thomas });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  await admin('PATCH', `/api/admin/matches/${id}`, { status: 'open' });
  assert.equal((await reg(client(), id, { link_token: tok.open, first_name: 'Nouveau', phone: freshPhone() })).status, 201);
  assert.equal((await reg(client(), id, { link_token: tok.priority, first_name: 'Autre', phone: freshPhone() })).status, 201);
  assert.equal((await reg(client(), id, { link_token: tok.invite, first_name: 'Invité', phone: freshPhone() })).body.error, 'not_open');

  await admin('PATCH', `/api/admin/matches/${id}`, { status: 'invite' });
  for (const [lvl, name] of [['invite', 'Invité'], ['open', 'Encore'], ['priority', 'Toujours']]) {
    r = await reg(client(), id, { link_token: tok[lvl], first_name: name, phone: freshPhone() });
    assert.equal(r.status, 201, `${lvl} ${JSON.stringify(r.body)}`);
  }

  await admin('PATCH', `/api/admin/matches/${id}`, { status: 'closed' });
  r = await reg(client(), id, { link_token: tok.invite, first_name: 'Tard', phone: freshPhone() });
  assert.equal(r.body.error, 'closed');
});

test('liens invalides : token inconnu, modifié ou d’un autre match', async (t) => {
  const { admin, client } = await setup(t);
  const a = await newMatch(admin, { status: 'invite' });
  const b = await newMatch(admin, { status: 'invite', date: '2099-06-12' });
  const tokA = a.links[0].token;
  const tokB = b.links[2].token;
  const phone = client();
  const who = { first_name: 'Zed', phone: freshPhone() };

  for (const bad of ['nimportequoi-nimportequoi-123', tokA.slice(0, -1) + (tokA.endsWith('A') ? 'B' : 'A')]) {
    const g = await phone.call('GET', `/api/public/links/${bad}`);
    assert.equal(g.body.state, 'invalid');
    assert.equal(g.body.message, 'Ce lien d’inscription n’est pas valide.');
    assert.equal(g.body.current, undefined);
    const r = await reg(phone, a.match.id, { link_token: bad, ...who });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'invalid_link');
  }
  assert.equal((await reg(phone, a.match.id, { link_token: tokB, ...who })).body.error, 'invalid_link');
  assert.equal((await reg(phone, a.match.id, who)).body.error, 'invalid_link');
});

test('les tokens sont longs, aléatoires et uniques', async (t) => {
  const { admin } = await setup(t);
  const all = (await admin('GET', '/api/admin/matches')).body.matches;
  const tokens = [];
  for (const m of all) tokens.push(...(await admin('GET', `/api/admin/matches/${m.id}`)).body.links.map((l) => l.token));
  assert.ok(tokens.every((tk) => /^[A-Za-z0-9_-]{43}$/.test(tk)));
  assert.equal(new Set(tokens).size, tokens.length);
});

/* =========================================================
   Identification par téléphone
   ========================================================= */

test('identification : numéro connu → bonne fiche, abonnement, participations et tarif', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = tokenOf(m, 'open');
  // Numéro saisi dans un autre format que celui enregistré (+33639980001)
  const r = await reg(client(), m.match.id, { link_token: tok, first_name: 'thomas', phone: '06.39.98.00.01' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created_player, false);
  assert.equal(r.body.registration.first_name, 'Thomas');
  assert.equal(r.body.registration.price_cents, 500);
  assert.equal(r.body.registration.tier, 'annual');
  const v = (await admin('GET', `/api/admin/matches/${m.match.id}`)).body;
  assert.equal(v.registrations[0].player_id, P('Thomas').id);
  const detail = (await admin('GET', `/api/admin/players/${P('Thomas').id}`)).body.player;
  assert.equal(detail.label, 'Abonné annuel');
  assert.equal(detail.participations, 12);
});

test('unicité : un numéro = une fiche, quelle que soit l’écriture ; deux Thomas = deux fiches', async (t) => {
  const { admin, client } = await setup(t);
  const m1 = await newMatch(admin, { status: 'open' });
  const m2 = await newMatch(admin, { status: 'open', date: '2099-06-12' });
  let r = await reg(client(), m1.match.id, { link_token: tokenOf(m1, 'open'), first_name: 'Karl', phone: '07 11 22 33 44' });
  assert.equal(r.body.created_player, true);
  r = await reg(client(), m2.match.id, { link_token: tokenOf(m2, 'open'), first_name: 'Karl', phone: '+33711223344' });
  assert.equal(r.status, 201);
  assert.equal(r.body.created_player, false, 'même numéro normalisé → même fiche');
  let karls = (await admin('GET', '/api/admin/players')).body.players.filter((p) => p.first_name === 'Karl');
  assert.equal(karls.length, 1);
  assert.equal(karls[0].phone, '+33711223344');
  assert.equal(karls[0].registrations_total, 2);

  // Deux Thomas avec deux numéros différents
  await reg(client(), m1.match.id, { link_token: tokenOf(m1, 'open'), first_name: 'Thomas', phone: '07 00 00 00 01' });
  r = await reg(client(), m1.match.id, { link_token: tokenOf(m1, 'open'), first_name: 'Thomas', phone: '07 00 00 00 02' });
  assert.equal(r.status, 201);
  const thomas = (await admin('GET', '/api/admin/players')).body.players.filter((p) => p.first_name === 'Thomas');
  assert.equal(thomas.length, 3, 'le Thomas de la démo + deux nouveaux Thomas');
  assert.equal(new Set(thomas.map((p) => p.phone)).size, 3);

  // Contrainte UNIQUE côté SQLite, indépendamment du code applicatif
  const created = await admin('POST', '/api/admin/players', { first_name: 'Doublon', phone: '0711223344' });
  assert.equal(created.status, 409);
  assert.equal(created.body.error, 'phone_taken');
  karls = (await admin('GET', '/api/admin/players')).body.players.filter((p) => p.phone === '+33711223344');
  assert.equal(karls.length, 1);
});

test('identification : prénom très différent refusé sans révéler le prénom enregistré ; petites variations acceptées', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = tokenOf(m, 'open');
  const r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Kevin', phone: P('Thomas').phone });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'phone_name_mismatch');
  assert.equal(r.body.message, 'Ce numéro est déjà associé à un joueur. Vérifie ton prénom ou contacte l’organisateur.');
  assert.ok(!r.text.includes('Thomas'), 'le prénom associé n’est jamais révélé');
  // Aucune fiche créée
  assert.ok(!(await admin('GET', '/api/admin/players')).body.players.some((p) => p.first_name === 'Kevin'));

  for (const [variant, name] of [['  lucas ', 'Lucas'], ['HUGO', 'Hugo'], ['Antóine', 'Antoine'], ['Maxime D.', 'Maxime']]) {
    const x = await reg(client(), m.match.id, { link_token: tok, first_name: variant, phone: P(name).phone });
    assert.equal(x.status, 201, `${variant} ${JSON.stringify(x.body)}`);
    assert.equal(x.body.created_player, false);
  }
});

test('double inscription : même joueur + même match refusé, sa confirmation est renvoyée', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = tokenOf(m, 'open');
  const who = { first_name: 'Lucas', phone: P('Lucas').phone };
  assert.equal((await reg(client(), m.match.id, { link_token: tok, ...who, payment_method: 'cash' })).status, 201);
  const again = await reg(client(), m.match.id, { link_token: tok, first_name: 'lucas', phone: '06-39-98-00-06' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_registered');
  assert.equal(again.body.message, 'Tu es déjà inscrit à ce foot ✅');
  assert.equal(again.body.registration.payment_method, 'cash');
  assert.equal(again.body.registration.price_cents, 1000);
  const v = (await admin('GET', `/api/admin/matches/${m.match.id}`)).body;
  assert.equal(v.registrations.length, 1);

  // Retrouver sa confirmation (prénom + numéro), mais rien avec un mauvais prénom
  let l = await client().call('POST', `/api/public/matches/${m.match.id}/lookup`, { link_token: tok, ...who });
  assert.equal(l.body.registration.price_cents, 1000);
  l = await client().call('POST', `/api/public/matches/${m.match.id}/lookup`, { link_token: tok, first_name: 'Autre', phone: who.phone });
  assert.equal(l.body.registration, null);
  l = await client().call('POST', `/api/public/matches/${m.match.id}/lookup`, { link_token: 'faux-lien-faux-lien-faux', ...who });
  assert.equal(l.status, 404);
});

test('numéro invalide ou manquant : refusé proprement', async (t) => {
  const { admin, client } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = tokenOf(m, 'open');
  let r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Sans' });
  assert.equal(r.body.error, 'phone_required');
  r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Faux', phone: '12 34' });
  assert.equal(r.body.error, 'phone_invalid');
  assert.equal((await admin('GET', `/api/admin/matches/${m.match.id}`)).body.registrations.length, 0);
});

/* =========================================================
   Priorité
   ========================================================= */

test('priorité : abonnés annuel / fidélité / 5 participations acceptés, non abonnés refusés en phase Prioritaires', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'priority' });
  const tok = tokenOf(m, 'priority');
  for (const name of ['Thomas', 'Hugo', 'Antoine']) {
    const r = await reg(client(), m.match.id, { link_token: tok, first_name: name, phone: P(name).phone });
    assert.equal(r.status, 201, `${name} ${JSON.stringify(r.body)}`);
  }
  let r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Lucas', phone: P('Lucas').phone });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'priority_only');
  assert.match(r.body.message, /réservées aux joueurs prioritaires/);
  const inconnu = freshPhone();
  r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Inconnu', phone: inconnu });
  assert.equal(r.body.error, 'priority_only');
  assert.ok(!(await admin('GET', '/api/admin/players')).body.players.some((p) => p.first_name === 'Inconnu'), 'aucune fiche créée');

  await admin('PATCH', `/api/admin/matches/${m.match.id}`, { status: 'open' });
  r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Lucas', phone: P('Lucas').phone });
  assert.equal(r.status, 201);
  assert.equal(r.body.registration.price_cents, 1000);
});

/* =========================================================
   Tarifs
   ========================================================= */

test('tarifs : abonnés 5 €, non abonnés 10 € jusqu’à 5 participations', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = tokenOf(m, 'open');
  const signup = async (name, phone = P(name).phone) => {
    const r = await reg(client(), m.match.id, { link_token: tok, first_name: name, phone });
    assert.equal(r.status, 201, `${name} ${JSON.stringify(r.body)}`);
    return r.body.registration;
  };
  assert.equal((await signup('Thomas')).price_cents, 500);
  assert.equal((await signup('Hugo')).price_cents, 500);
  for (const [name, n] of [['Pierre', 0], ['Sam', 1], ['Maxime', 4]]) {
    await admin('PATCH', `/api/admin/players/${P(name).id}`, { participations: n });
    const r = await signup(name);
    assert.equal(r.price_cents, 1000, `${name} avec ${n} participations`);
    assert.equal(r.loyalty_upgrade, false);
  }
  assert.equal((await signup('Nouvelle', freshPhone())).price_cents, 1000);
});

test('fidélité : après 5 participations validées, la 6e inscription est à 5 € et le joueur devient Abonné fidélité', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const antoine = P('Antoine');
  assert.equal(antoine.subscription, 'none');
  assert.equal(antoine.participations, 5);
  assert.equal(antoine.loyalty_eligible, true);

  const r = await reg(client(), m.match.id, { link_token: tokenOf(m, 'open'), first_name: 'Antoine', phone: antoine.phone });
  assert.equal(r.status, 201);
  assert.equal(r.body.registration.price_cents, 500);
  assert.equal(r.body.registration.loyalty_upgrade, true);
  const after = (await admin('GET', `/api/admin/players/${antoine.id}`)).body.player;
  assert.equal(after.label, 'Abonné fidélité');
  assert.equal(after.priority, true);

  const m2 = await newMatch(admin, { status: 'priority', date: '2099-06-12' });
  const r2 = await reg(client(), m2.match.id, { link_token: tokenOf(m2, 'priority'), first_name: 'Antoine', phone: antoine.phone });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.registration.price_cents, 500);
  assert.equal(r2.body.registration.tier, 'loyalty');
});

/* =========================================================
   Liens de paiement 5 € / 10 € choisis par le serveur
   ========================================================= */

const L5 = 'https://banque.example/pay/cinq-euros';
const L10 = 'https://banque.example/pay/dix-euros';

async function withLinks(t, links = { 500: L5, 1000: L10 }) {
  const ctx = await setup(t);
  const r = await ctx.admin('PATCH', '/api/admin/settings', { payment_links: links });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = await newMatch(ctx.admin, { status: 'open' });
  const tok = tokenOf(m, 'open');
  const signup = (name, extra = {}) => reg(ctx.client(), m.match.id, {
    link_token: tok, first_name: name, phone: ctx.P(name)?.phone || freshPhone(), ...extra,
  });
  return { ...ctx, m, tok, signup };
}

test('lien carte : 5 € pour abonnés annuels, fidélité et fidélité acquise ; 10 € pour les autres', async (t) => {
  const { signup } = await withLinks(t);
  for (const [name, price, link] of [['Thomas', 500, L5], ['Hugo', 500, L5], ['Antoine', 500, L5], ['Lucas', 1000, L10], ['Maxime', 1000, L10], ['Inconnu', 1000, L10]]) {
    const r = await signup(name);
    assert.equal(r.status, 201, `${name} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.registration.price_cents, price, name);
    assert.equal(r.body.payment_link, link, name);
  }
});

test('lien carte : impossible de forcer le tarif ou le lien depuis le navigateur', async (t) => {
  const { signup, admin, m } = await withLinks(t);
  const r = await signup('Tricheur', {
    price_cents: 500, amount: 5, tier: 'annual', subscription: 'annual', payment_link: L5, payment_status: 'paid',
    claims_subscriber: true, player_id: 1,
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.registration.price_cents, 1000);
  assert.equal(r.body.payment_link, L10);
  const v = (await admin('GET', `/api/admin/matches/${m.match.id}`)).body.registrations.find((x) => x.first_name === 'Tricheur');
  assert.equal(v.price_cents, 1000);
  assert.equal(v.payment_status, 'to_pay');
  assert.notEqual(v.player_id, 1);
});

test('lien carte : lien manquant → aucun lien, jamais celui de l’autre montant', async (t) => {
  let ctx = await withLinks(t, { 500: '', 1000: L10 });
  let r = await ctx.signup('Thomas');
  assert.equal(r.body.registration.price_cents, 500);
  assert.equal(r.body.payment_link, '');
  assert.equal((await ctx.signup('Lucas')).body.payment_link, L10);
  assert.deepEqual((await ctx.admin('GET', '/api/admin/overview')).body.warnings.missing_card_links, [500]);

  ctx = await withLinks(t, { 500: L5, 1000: '' });
  r = await ctx.signup('Lucas');
  assert.equal(r.body.registration.price_cents, 1000);
  assert.equal(r.body.payment_link, '');
  assert.equal((await ctx.signup('Thomas')).body.payment_link, L5);
});

test('lien carte : aucun lien pour un paiement en espèces, ni dans la confirmation retrouvée', async (t) => {
  const { client, m, tok, P } = await withLinks(t);
  const who = { first_name: 'Thomas', phone: P('Thomas').phone };
  const r = await reg(client(), m.match.id, { link_token: tok, ...who, payment_method: 'cash' });
  assert.equal(r.status, 201);
  assert.equal(r.body.payment_link, '');
  assert.ok(!r.text.includes(L5) && !r.text.includes(L10));
  const again = await client().call('POST', `/api/public/matches/${m.match.id}/lookup`, { link_token: tok, ...who });
  assert.equal(again.body.registration.payment_link, '');
  assert.equal(again.body.registration.price_cents, 500);
});

test('lien carte : jamais exposé aux autres, et tarif historique conservé', async (t) => {
  const { client, admin, m, tok, P } = await withLinks(t);
  for (const url of ['/api/public/match', `/api/public/links/${tok}`, `/api/public/matches/${m.match.id}`]) {
    const x = await client().call('GET', url);
    assert.ok(!x.text.includes(L5) && !x.text.includes(L10), url);
  }
  const lucas = { first_name: 'Lucas', phone: P('Lucas').phone };
  let r = await reg(client(), m.match.id, { link_token: tok, ...lucas });
  assert.equal(r.body.payment_link, L10);
  await admin('PATCH', `/api/admin/players/${P('Lucas').id}`, { subscription: 'loyalty' });
  const old = await client().call('POST', `/api/public/matches/${m.match.id}/lookup`, { link_token: tok, ...lucas });
  assert.equal(old.body.registration.price_cents, 1000);
  assert.equal(old.body.registration.payment_link, L10);
  const hist = (await admin('GET', `/api/admin/players/${P('Lucas').id}`)).body.history.find((x) => x.match_id === m.match.id);
  assert.equal(hist.price_cents, 1000);
  const m2 = await newMatch(admin, { status: 'open', date: '2099-06-12' });
  r = await reg(client(), m2.match.id, { link_token: tokenOf(m2, 'open'), ...lucas });
  assert.equal(r.body.registration.price_cents, 500);
  assert.equal(r.body.payment_link, L5);
});

test('réglages des liens : https obligatoire, liens différents, admin uniquement', async (t) => {
  const { admin, client } = await setup(t);
  assert.equal((await admin('PATCH', '/api/admin/settings', { payment_links: { 500: 'http://pas-securise.fr' } })).status, 400);
  assert.equal((await admin('PATCH', '/api/admin/settings', { payment_links: { 500: L5, 1000: L5 } })).status, 400);
  assert.equal((await admin('PATCH', '/api/admin/settings', { payment_links: { 500: L5, 1000: L10 } })).status, 200);
  const s = (await admin('GET', '/api/admin/settings')).body;
  assert.equal(s.payment_links['500'], L5);
  assert.equal(s.payment_links['1000'], L10);
  const anon = client();
  assert.equal((await anon.call('PATCH', '/api/admin/settings', { payment_links: { 1000: L5 } })).status, 401);
  assert.equal((await anon.call('GET', '/api/admin/settings')).status, 401);
});

/* =========================================================
   Participations
   ========================================================= */

test('participations : seules les présences comptent, recalcul sans double comptage', async (t) => {
  const { admin, client } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const r = await reg(client(), m.match.id, { link_token: tokenOf(m, 'open'), first_name: 'Compteur', phone: freshPhone() });
  assert.equal(r.status, 201);
  const pid = (await admin('GET', '/api/admin/players')).body.players.find((p) => p.first_name === 'Compteur').id;
  const count = async () => (await admin('GET', `/api/admin/players/${pid}`)).body.player.participations;
  const regId = (await admin('GET', `/api/admin/matches/${m.match.id}`)).body.registrations.find((x) => x.player_id === pid).id;

  assert.equal(await count(), 0, 'inscription seule');
  await admin('PATCH', `/api/admin/registrations/${regId}`, { attendance: 'absent' });
  assert.equal(await count(), 0, 'absent');
  await admin('PATCH', `/api/admin/registrations/${regId}`, { attendance: 'present' });
  assert.equal(await count(), 1, 'présent');
  await admin('PATCH', `/api/admin/registrations/${regId}`, { attendance: 'present' });
  assert.equal(await count(), 1, 'pas de double comptage');
  await admin('PATCH', `/api/admin/registrations/${regId}`, { attendance: 'absent' });
  assert.equal(await count(), 0, 'présent → absent recalculé');
  await admin('PATCH', `/api/admin/registrations/${regId}`, { attendance: 'present' });

  await admin('PATCH', `/api/admin/players/${pid}`, { participations: 4 });
  assert.equal(await count(), 4);
  const m2 = await newMatch(admin, { status: 'open', date: '2099-06-12' });
  await admin('POST', `/api/admin/matches/${m2.match.id}/registrations`, { player_id: pid, payment_method: 'card' });
  const reg2 = (await admin('GET', `/api/admin/matches/${m2.match.id}`)).body.registrations[0];
  assert.equal(reg2.price_cents, 1000);
  await admin('PATCH', `/api/admin/registrations/${reg2.id}`, { attendance: 'present' });
  assert.equal(await count(), 5);
});

/* =========================================================
   Capacité
   ========================================================= */

test('capacité : impossible de dépasser le maximum, même en simultané', async (t) => {
  const { admin, client } = await setup(t);
  const m = await newMatch(admin, { status: 'open', capacity: 5 });
  const tok = tokenOf(m, 'open');
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    reg(client(), m.match.id, { link_token: tok, first_name: `Joueur${String.fromCharCode(65 + i)}`, phone: freshPhone() })));
  assert.equal(results.filter((r) => r.status === 201).length, 5);
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.body.error === 'full'));
  assert.equal((await admin('GET', `/api/admin/matches/${m.match.id}`)).body.stats.registered, 5);
  assert.equal((await admin('POST', `/api/admin/matches/${m.match.id}/registrations`, { first_name: 'EnTrop', payment_method: 'cash' })).body.error, 'full');
});

/* =========================================================
   Données publiques
   ========================================================= */

test('données publiques : ni numéros, ni paiements, ni autres tokens, ni anciens codes', async (t) => {
  const { admin, client, current, P } = await setup(t);
  const tokens = current.links.map((l) => l.token);
  // Un joueur s'inscrit : son numéro ne doit apparaître nulle part pour les autres
  await admin('PATCH', `/api/admin/matches/${current.match.id}`, { status: 'open' });
  await reg(client(), current.match.id, { link_token: tokens[1], first_name: 'Lucas', phone: P('Lucas').phone });
  const phones = (await admin('GET', '/api/admin/players')).body.players.map((p) => p.phone).filter(Boolean);
  const phone = client();
  const responses = [
    await phone.call('GET', '/api/public/match'),
    await phone.call('GET', `/api/public/matches/${current.match.id}`),
    await phone.call('GET', `/api/public/links/${tokens[0]}`),
    await phone.call('GET', `/api/public/links/${tokens[1]}`),
  ];
  for (const r of responses) {
    const raw = r.text;
    for (const leak of ['payment_status', 'paid', 'cash_due', 'to_pay', 'payment_method', 'payment_link', 'tier', 'attendance', 'subscription', 'session', 'password', 'hash', 'is_demo', 'code', 'player_code', 'phone', 'phone_normalized']) {
      assert.ok(!raw.includes(`"${leak}"`), `fuite publique du champ ${leak}`);
    }
    for (const tk of tokens) assert.ok(!raw.includes(tk), 'aucun token de lien exposé');
    for (const p of phones) {
      assert.ok(!raw.includes(p) && !raw.includes(p.replace('+33', '0')), 'aucun numéro exposé');
    }
  }
  assert.equal((await reg(phone, current.match.id, { first_name: 'Malin', phone: freshPhone() })).body.error, 'invalid_link');
});

/* =========================================================
   Administration
   ========================================================= */

test('administration : tout est refusé sans authentification (joueurs, téléphone, fusion)', async (t) => {
  const { client, P, current } = await setup(t);
  const anon = client();
  const checks = [
    ['GET', '/api/admin/overview'],
    ['GET', '/api/admin/players'],
    ['GET', `/api/admin/players/${P('Lucas').id}`],
    ['PATCH', `/api/admin/players/${P('Lucas').id}`, { subscription: 'annual' }],
    ['PATCH', `/api/admin/players/${P('Lucas').id}`, { phone: '0700000000' }],
    ['POST', `/api/admin/players/${P('Lucas').id}/merge`, { into_player_id: P('Hugo').id }],
    ['DELETE', `/api/admin/players/${P('Lucas').id}`, {}],
    ['POST', '/api/admin/players', { first_name: 'X', phone: '0700000001' }],
    ['GET', `/api/admin/matches/${current.match.id}`],
    ['PATCH', `/api/admin/matches/${current.match.id}`, { status: 'invite' }],
    ['POST', '/api/admin/seasons', { name: 'Hack' }],
    ['PATCH', '/api/admin/registrations/1', { payment_status: 'paid' }],
    ['POST', '/api/admin/password', { current: 'x', next: 'yyyyyyyyyyyy' }],
  ];
  for (const [method, url, body] of checks) {
    assert.equal((await anon.call(method, url, body)).status, 401, `${method} ${url}`);
  }
  anon.jar.fdv_admin = 'eyJleHAiOjk5OTk5OTk5OTk5OTl9.fake';
  assert.equal((await anon.call('GET', '/api/admin/players')).status, 401);
});

test('administration : téléphone visible, modifiable, normalisé et unique ; plus aucun code joueur', async (t) => {
  const { admin, P } = await setup(t);
  const list = (await admin('GET', '/api/admin/players')).body.players;
  const thomas = list.find((p) => p.first_name === 'Thomas');
  assert.equal(thomas.phone, '+33639980001');
  assert.equal(thomas.phone_display, '06 39 98 00 01');
  assert.ok(list.every((p) => !('code' in p)), 'plus de champ code');

  let d = (await admin('PATCH', `/api/admin/players/${P('Lucas').id}`, { phone: '07.12.34.56.78' })).body;
  assert.equal(d.player.phone, '+33712345678');
  const clash = await admin('PATCH', `/api/admin/players/${P('Hugo').id}`, { phone: '+33 7 12 34 56 78' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'phone_taken');
  assert.match(clash.body.message, /Fusionner/);
  assert.equal(clash.body.other_player_id, P('Lucas').id);
  d = (await admin('GET', `/api/admin/players/${P('Hugo').id}`)).body;
  assert.equal(d.player.phone, '+33639980003', 'numéro de Hugo non écrasé');
  assert.equal((await admin('PATCH', `/api/admin/players/${P('Hugo').id}`, { phone: '12' })).status, 400);

  d = (await admin('PATCH', `/api/admin/players/${P('Lucas').id}`, { subscription: 'annual' })).body;
  assert.equal(d.player.label, 'Abonné annuel');
  assert.equal(d.player.price_cents, 500);

  assert.equal((await admin('POST', '/api/admin/password', { current: 'secret-test-password', next: 'court12' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/password', { current: 'secret-test-password', next: 'nouveau-mot-de-passe' })).status, 200);
});

test('fusion : historique, participations, abonnement et numéro choisi conservés, sans double comptage', async (t) => {
  const { admin, client } = await setup(t);
  // Ancienne fiche sans numéro, abonnée, avec une présence
  const old = (await admin('POST', '/api/admin/players', { first_name: 'Paul', subscription: 'annual' })).body.player;
  assert.equal(old.missing_phone, true);
  const m1 = await newMatch(admin, { status: 'open' });
  await admin('POST', `/api/admin/matches/${m1.match.id}/registrations`, { player_id: old.id, payment_method: 'cash' });
  const r1 = (await admin('GET', `/api/admin/matches/${m1.match.id}`)).body.registrations[0];
  await admin('PATCH', `/api/admin/registrations/${r1.id}`, { attendance: 'present' });

  // Paul s'inscrit en ligne avec son numéro : nouvelle fiche (jamais rattachée sur le seul prénom), marquée « à vérifier »
  const m2 = await newMatch(admin, { status: 'open', date: '2099-06-12' });
  const r = await reg(client(), m2.match.id, { link_token: tokenOf(m2, 'open'), first_name: 'Paul', phone: '07 99 88 77 66' });
  assert.equal(r.body.created_player, true);
  assert.equal(r.body.registration.price_cents, 1000, 'aucun tarif abonné accordé sur le seul prénom');
  const fresh = (await admin('GET', '/api/admin/players')).body.players.find((p) => p.phone === '+33799887766');
  assert.equal(fresh.needs_review, true);
  assert.equal((await admin('GET', '/api/admin/overview')).body.warnings.players_to_review, 1);

  // L'admin fusionne l'ancienne fiche dans la nouvelle : tout est regroupé, numéro conservé
  const merged = await admin('POST', `/api/admin/players/${old.id}/merge`, { into_player_id: fresh.id, phone_from: 'target' });
  assert.equal(merged.status, 200);
  const p = merged.body.player;
  assert.equal(p.phone, '+33799887766');
  assert.equal(p.label, 'Abonné annuel');
  assert.equal(p.participations, 1);
  assert.equal(p.needs_review, false);
  assert.equal(merged.body.history.length, 2);
  assert.deepEqual(merged.body.history.map((h) => h.price_cents).sort(), [1000, 500].sort());
  assert.equal((await admin('GET', '/api/admin/players')).body.players.filter((x) => x.first_name === 'Paul').length, 1);

  // Choix du numéro de la fiche source
  const a = (await admin('POST', '/api/admin/players', { first_name: 'Zoé', phone: '0711111111' })).body.player;
  const b = (await admin('POST', '/api/admin/players', { first_name: 'Zoé', phone: '0722222222' })).body.player;
  const z = (await admin('POST', `/api/admin/players/${a.id}/merge`, { into_player_id: b.id, phone_from: 'source' })).body.player;
  assert.equal(z.phone, '+33711111111');

  // Conflit : deux fiches inscrites au même match → fusion refusée
  const c = (await admin('POST', '/api/admin/players', { first_name: 'Jo', phone: '0733333333' })).body.player;
  const e = (await admin('POST', '/api/admin/players', { first_name: 'Jo', phone: '0744444444' })).body.player;
  await admin('POST', `/api/admin/matches/${m1.match.id}/registrations`, { player_id: c.id, payment_method: 'cash' });
  await admin('POST', `/api/admin/matches/${m1.match.id}/registrations`, { player_id: e.id, payment_method: 'cash' });
  assert.equal((await admin('POST', `/api/admin/players/${c.id}/merge`, { into_player_id: e.id })).status, 409);
});

/* =========================================================
   Historique et saisons
   ========================================================= */

test('historique : le tarif enregistré ne change pas quand le joueur devient abonné', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  await reg(client(), m.match.id, { link_token: tokenOf(m, 'open'), first_name: 'Lucas', phone: P('Lucas').phone });
  await admin('PATCH', `/api/admin/players/${P('Lucas').id}`, { subscription: 'annual' });
  const r = (await admin('GET', `/api/admin/matches/${m.match.id}`)).body.registrations.find((x) => x.player_id === P('Lucas').id);
  assert.equal(r.price_cents, 1000);
  assert.equal(r.tier_label, 'Non abonné');
});

test('saisons : nouvelle saison = compteurs à zéro, anciennes données conservées', async (t) => {
  const { admin, P } = await setup(t);
  const before = (await admin('GET', '/api/admin/matches')).body.matches;
  const thomasBefore = (await admin('GET', `/api/admin/players/${P('Thomas').id}`)).body;
  const oldSeasonId = thomasBefore.season_id;
  const s = await admin('POST', '/api/admin/seasons', { name: '2027–2028', carry_annual: true });
  assert.equal(s.status, 201);
  assert.equal(s.body.seasons.length, 2);
  assert.equal((await admin('GET', '/api/admin/matches')).body.matches.length, before.length);
  const hugo = (await admin('GET', `/api/admin/players/${P('Hugo').id}`)).body;
  assert.equal(hugo.player.participations, 0);
  assert.equal(hugo.player.label, 'Non abonné');
  const oldHugo = hugo.seasons.find((x) => x.id === oldSeasonId);
  assert.equal(oldHugo.label, 'Abonné fidélité');
  assert.equal(oldHugo.participations, 7);
  const thomas = (await admin('GET', `/api/admin/players/${P('Thomas').id}`)).body;
  assert.equal(thomas.player.label, 'Abonné annuel');
  assert.equal(thomas.player.phone, '+33639980001', 'le numéro suit la fiche d’une saison à l’autre');
  assert.equal(thomas.history.length, thomasBefore.history.length);
});

/* =========================================================
   Migration (ancienne base avec code joueur)
   ========================================================= */

test('migration : fiches à code conservées sans numéro inventé, jamais fusionnées par prénom', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdv-mig-'));
  const file = path.join(dir, 'old.sqlite');

  // 1. Base « version précédente » (schéma v4, avec la colonne code), données réelles
  let db = openDatabase(file, { untilVersion: 4 });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.ok(db.prepare('PRAGMA table_info(players)').all().some((c) => c.name === 'code'));
  const sid = currentSeasonId(db);
  const t1 = createPlayer(db, { first_name: 'Thomas', season_id: sid, subscription: 'annual', adjustment: 3 });
  const t2 = createPlayer(db, { first_name: 'Thomas', season_id: sid, subscription: 'none' });
  const mid = Number(db.prepare(`INSERT INTO matches (date, time, location, price_cents, subscriber_price_cents, capacity, status, season_id)
                                 VALUES ('2026-09-18', '20:00', 'Five', 1000, 500, 14, 'closed', ?)`).run(sid).lastInsertRowid);
  ensureMatchLinks(db, mid);
  const ins = db.prepare(`INSERT INTO registrations (match_id, player_id, first_name, name_key, payment_method, payment_status, token, price_cents, tier, attendance)
                          VALUES (?, ?, 'Thomas', 'thomas', ?, ?, 'x', ?, ?, 'present')`);
  ins.run(mid, t1, 'card', 'paid', 500, 'annual');
  ins.run(mid, t2, 'cash', 'cash_due', 1000, 'standard');
  const codes = db.prepare('SELECT code FROM players').all().map((r) => r.code);
  assert.ok(codes.every((c) => /^\d{4}$/.test(c)));
  db.close();

  // 2. Démarrage de la nouvelle version sur cette base
  const ctx = await startServer({ dbFile: file });
  t.after(() => ctx.server.close());
  const { admin, client } = ctx;
  db = openDatabase(file);
  assert.ok(!db.prepare('PRAGMA table_info(players)').all().some((c) => c.name === 'code'), 'colonne code supprimée');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_players_phone' AND sql LIKE '%UNIQUE%'").get(), 'index UNIQUE sur le numéro');
  db.close();

  const players = (await admin('GET', '/api/admin/players')).body.players;
  const thomas = players.filter((p) => p.first_name === 'Thomas');
  assert.equal(thomas.length, 2, 'les deux anciennes fiches Thomas restent séparées');
  assert.ok(thomas.every((p) => p.phone === null && p.missing_phone), 'aucun numéro inventé');
  const a = thomas.find((p) => p.id === t1);
  assert.equal(a.subscription, 'annual');
  assert.equal(a.participations, 4, '1 présence + 3 participations antérieures');
  const hist = (await admin('GET', `/api/admin/players/${t1}`)).body.history;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].price_cents, 500);
  assert.equal(hist[0].payment_status, 'paid');
  const matchView = (await admin('GET', `/api/admin/matches/${mid}`)).body;
  assert.equal(matchView.registrations.length, 2, 'inscriptions conservées');
  assert.ok(!JSON.stringify(players).includes('"code"'));

  // 3. Un ancien joueur sans numéro s'inscrit : nouvelle fiche à vérifier, pas de rattachement automatique
  const m = await newMatch(admin, { status: 'open' });
  const r = await reg(client(), m.match.id, { link_token: tokenOf(m, 'open'), first_name: 'Thomas', phone: '06 55 44 33 22' });
  assert.equal(r.status, 201);
  assert.equal(r.body.created_player, true);
  assert.equal(r.body.registration.price_cents, 1000);
  const after = (await admin('GET', '/api/admin/players')).body.players.filter((p) => p.first_name === 'Thomas');
  assert.equal(after.length, 3);
  assert.ok(after.find((p) => p.phone === '+33655443322').needs_review);

  // 4. L'organisateur renseigne le numéro de l'ancienne fiche abonnée : elle est ensuite reconnue
  const set = await admin('PATCH', `/api/admin/players/${t2}`, { phone: '06 11 22 33 44' });
  assert.equal(set.body.player.phone, '+33611223344');
  const m2 = await newMatch(admin, { status: 'open', date: '2099-06-12' });
  await admin('PATCH', `/api/admin/players/${t1}`, { phone: '0612121212' });
  const r2 = await reg(client(), m2.match.id, { link_token: tokenOf(m2, 'open'), first_name: 'Thomas', phone: '06 12 12 12 12' });
  assert.equal(r2.body.created_player, false);
  assert.equal(r2.body.registration.price_cents, 500, 'abonné reconnu par son numéro');
});

test('démo : numéros fictifs attribués uniquement aux profils de démonstration', async (t) => {
  const { P } = await setup(t);
  for (const [name, label] of [['Thomas', 'Abonné annuel'], ['Hugo', 'Abonné fidélité'], ['Lucas', 'Non abonné']]) {
    assert.equal(P(name).label, label);
    assert.match(P(name).phone, /^\+3363998\d{4}$/, 'plage fictive 06 39 98');
  }
  assert.equal(P('Antoine').participations, 5);
});

/* =========================================================
   Sécurité HTML / en-têtes / déploiement
   ========================================================= */

test('en-têtes de sécurité, pas d’innerHTML avec des données, Dockerfile sans VOLUME', async (t) => {
  const { admin, client, base } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = tokenOf(m, 'open');
  const r = await reg(client(), m.match.id, { link_token: tok, first_name: '<img src=x onerror=1>Bob', phone: freshPhone() });
  assert.equal(r.status, 201);
  const page = await fetch(`${base}/i/${tok}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const src = ['player.js', 'admin.js', 'common.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')).join('\n');
  assert.equal((src.match(/innerHTML/g) || []).length, 1, 'innerHTML uniquement dans h() pour les icônes internes');
  assert.ok(!/player_code|code joueur/i.test(src), 'plus aucune trace du code joueur côté interface');
  const docker = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.ok(!/^\s*VOLUME/m.test(docker), 'pas de VOLUME dans le Dockerfile');
  assert.match(docker, /DATA_DIR=\/data/);
});
