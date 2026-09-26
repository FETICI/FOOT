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

/* ---------- Outils ---------- */

async function startServer({ seed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdv-'));
  const server = http.createServer(createApp({ dbFile: path.join(dir, 'test.sqlite'), seed }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Un « navigateur » avec son propre pot de cookies (un téléphone, ou l'admin). */
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

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  const { admin } = ctx;
  const players = (await admin('GET', '/api/admin/players')).body.players;
  const P = (name) => players.find((p) => p.first_name === name);
  const current = (await admin('GET', '/api/admin/overview')).body.current;
  const link = (view, level) => view.links.find((l) => l.level === level).token;
  return { ...ctx, P, current, link };
}

/** Crée un match de test (phase donnée) et renvoie sa vue admin. */
async function newMatch(admin, over = {}) {
  const r = await admin('POST', '/api/admin/matches', {
    date: '2099-06-05', time: '20:00', location: 'Test', price_cents: 1000, subscriber_price_cents: 500, capacity: 20, status: 'priority', payment_link: '', ...over,
  });
  assert.equal(r.status, 201);
  return r.body;
}

const reg = (c, matchId, body) => c.call('POST', `/api/public/matches/${matchId}/registrations`, { payment_method: 'card', ...body });

/* =========================================================
   Accès / phases
   ========================================================= */

test('phases : chaque lien n’est actif qu’à partir de sa phase', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'priority' });
  const id = m.match.id;
  const tok = Object.fromEntries(m.links.map((l) => [l.level, l.token]));
  const thomas = P('Thomas');

  // Phase Prioritaires : lien Ouvert et Invitations refusés
  const phone = client();
  assert.equal((await phone.call('GET', `/api/public/links/${tok.open}`)).body.state, 'not_open');
  assert.equal((await phone.call('GET', `/api/public/links/${tok.invite}`)).body.state, 'not_open');
  let r = await reg(phone, id, { link_token: tok.open, first_name: 'Thomas', player_code: thomas.code });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'not_open');
  assert.equal(r.body.message, 'Les inscriptions ne sont pas encore ouvertes pour ce lien.');
  r = await reg(phone, id, { link_token: tok.invite, first_name: 'Thomas', player_code: thomas.code });
  assert.equal(r.body.error, 'not_open');

  // Lien Prioritaires actif
  assert.equal((await phone.call('GET', `/api/public/links/${tok.priority}`)).body.state, 'open');
  r = await reg(phone, id, { link_token: tok.priority, first_name: 'Thomas', player_code: thomas.code, claims_subscriber: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // Phase Ouvert : lien Ouvert actif, lien Prioritaires toujours actif, Invitations pas encore
  await admin('PATCH', `/api/admin/matches/${id}`, { status: 'open' });
  r = await reg(client(), id, { link_token: tok.open, first_name: 'Nouveau' });
  assert.equal(r.status, 201);
  r = await reg(client(), id, { link_token: tok.priority, first_name: 'Autre' });
  assert.equal(r.status, 201);
  r = await reg(client(), id, { link_token: tok.invite, first_name: 'Invité' });
  assert.equal(r.body.error, 'not_open');

  // Phase Invitations : les trois liens fonctionnent
  await admin('PATCH', `/api/admin/matches/${id}`, { status: 'invite' });
  for (const [lvl, name] of [['invite', 'Invité'], ['open', 'Encore'], ['priority', 'Toujours']]) {
    r = await reg(client(), id, { link_token: tok[lvl], first_name: name });
    assert.equal(r.status, 201, `${lvl} ${JSON.stringify(r.body)}`);
  }

  // Fermé : plus aucun lien
  await admin('PATCH', `/api/admin/matches/${id}`, { status: 'closed' });
  r = await reg(client(), id, { link_token: tok.invite, first_name: 'Tard' });
  assert.equal(r.body.error, 'closed');
});

test('liens invalides : token inconnu, modifié ou d’un autre match', async (t) => {
  const { admin, client } = await setup(t);
  const a = await newMatch(admin, { status: 'invite' });
  const b = await newMatch(admin, { status: 'invite', date: '2099-06-12' });
  const tokA = a.links[0].token;
  const tokB = b.links[2].token;
  const phone = client();

  for (const bad of ['nimportequoi-nimportequoi-123', tokA.slice(0, -1) + (tokA.endsWith('A') ? 'B' : 'A')]) {
    const g = await phone.call('GET', `/api/public/links/${bad}`);
    assert.equal(g.body.state, 'invalid');
    assert.equal(g.body.message, 'Ce lien d’inscription n’est pas valide.');
    assert.equal(g.body.current, undefined, 'aucune info de match pour un lien invalide');
    const r = await reg(phone, a.match.id, { link_token: bad, first_name: 'Zed' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'invalid_link');
  }
  // Token du match B utilisé pour le match A
  const r = await reg(phone, a.match.id, { link_token: tokB, first_name: 'Zed' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'invalid_link');
  // Sans token (lien général) : impossible de s'inscrire
  const g = await reg(phone, a.match.id, { first_name: 'Zed' });
  assert.equal(g.body.error, 'invalid_link');
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
   Priorité
   ========================================================= */

test('priorité : seuls les abonnés passent en phase Prioritaires, même avec le lien', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'priority' });
  const tok = Object.fromEntries(m.links.map((l) => [l.level, l.token]));

  // Abonné annuel
  let r = await reg(client(), m.match.id, { link_token: tok.priority, first_name: 'Thomas', player_code: P('Thomas').code, claims_subscriber: true });
  assert.equal(r.status, 201);
  // Abonné fidélité
  r = await reg(client(), m.match.id, { link_token: tok.priority, first_name: 'Hugo', player_code: P('Hugo').code, claims_subscriber: true });
  assert.equal(r.status, 201);
  // Non abonné avec le lien Prioritaires (fiche existante reconnue)
  const lucasPhone = client();
  r = await reg(lucasPhone, m.match.id, { link_token: tok.priority, first_name: 'Lucas', player_code: P('Lucas').code });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'priority_only');
  assert.match(r.body.message, /réservées aux joueurs prioritaires/);
  // Inconnu avec le lien Prioritaires
  r = await reg(client(), m.match.id, { link_token: tok.priority, first_name: 'Inconnu' });
  assert.equal(r.body.error, 'priority_only');
  // Aucune fiche créée pour l'inconnu refusé
  assert.ok(!(await admin('GET', '/api/admin/players')).body.players.some((p) => p.first_name === 'Inconnu'));

  // Passage en phase Ouvert : Lucas peut s'inscrire (même avec le lien Prioritaires)
  await admin('PATCH', `/api/admin/matches/${m.match.id}`, { status: 'open' });
  r = await reg(lucasPhone, m.match.id, { link_token: tok.priority, first_name: 'Lucas', player_code: P('Lucas').code });
  assert.equal(r.status, 201);
  assert.equal(r.body.registration.price_cents, 1000);
});

/* =========================================================
   Tarifs
   ========================================================= */

test('tarifs : abonnés 5 €, non abonnés 10 € jusqu’à 5 participations', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = m.links.find((l) => l.level === 'open').token;

  const signup = async (name, extra = {}) => {
    const r = await reg(client(), m.match.id, { link_token: tok, first_name: name, player_code: P(name)?.code, ...extra });
    assert.equal(r.status, 201, `${name} ${JSON.stringify(r.body)}`);
    return r.body.registration;
  };

  assert.equal((await signup('Thomas', { claims_subscriber: true })).price_cents, 500); // annuel
  assert.equal((await signup('Hugo', { claims_subscriber: true })).price_cents, 500);   // fidélité

  // Non abonnés avec 0, 1 et 4 participations
  for (const [name, n] of [['Pierre', 0], ['Sam', 1], ['Maxime', 4]]) {
    await admin('PATCH', `/api/admin/players/${P(name).id}`, { participations: n });
    const p = (await admin('GET', `/api/admin/players/${P(name).id}`)).body.player;
    assert.equal(p.participations, n);
    const r = await signup(name);
    assert.equal(r.price_cents, 1000, `${name} avec ${n} participations`);
    assert.equal(r.loyalty_upgrade, false);
  }
  // Nouveau joueur (aucune fiche) → 10 €
  assert.equal((await signup('Nouvelle')).price_cents, 1000);
});

test('fidélité : après 5 participations validées, la 6e inscription est à 5 € et le joueur devient Abonné fidélité', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = m.links.find((l) => l.level === 'open').token;
  const antoine = P('Antoine'); // démo : 5 participations, non abonné
  assert.equal(antoine.subscription, 'none');
  assert.equal(antoine.participations, 5);
  assert.equal(antoine.loyalty_eligible, true);

  const r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Antoine', player_code: antoine.code });
  assert.equal(r.status, 201);
  assert.equal(r.body.registration.price_cents, 500);
  assert.equal(r.body.registration.loyalty_upgrade, true);
  assert.equal(r.body.registration.tier, 'loyalty_upgrade');

  const after = (await admin('GET', `/api/admin/players/${antoine.id}`)).body.player;
  assert.equal(after.subscription, 'loyalty');
  assert.equal(after.label, 'Abonné fidélité');
  assert.equal(after.priority, true);

  // Il reste à 5 € ensuite (match suivant), et devient prioritaire en phase Prioritaires
  const m2 = await newMatch(admin, { status: 'priority', date: '2099-06-12' });
  const r2 = await reg(client(), m2.match.id, { link_token: m2.links[0].token, first_name: 'Antoine', player_code: antoine.code, claims_subscriber: true });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.registration.price_cents, 500);
  assert.equal(r2.body.registration.tier, 'loyalty');
});

test('déclarer « je suis abonné » sans l’être ne donne jamais 5 €', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = m.links.find((l) => l.level === 'open').token;

  // Nouveau prénom + « oui je suis abonné »
  let r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Menteur', claims_subscriber: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'subscriber_not_recognized');
  assert.equal(r.body.message, 'Ton statut abonné n’a pas été reconnu. Tu peux t’inscrire au tarif normal ou contacter l’organisateur.');

  // Vrai non-abonné, bien identifié, qui prétend être abonné
  r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Lucas', player_code: P('Lucas').code, claims_subscriber: true });
  assert.equal(r.body.error, 'subscriber_not_recognized');

  // Usurpation du prénom d'un abonné : code exigé, mauvais code refusé
  r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Thomas', claims_subscriber: true });
  assert.equal(r.body.error, 'code_required');
  const wrong = P('Thomas').code === '0000' ? '1111' : '0000';
  r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Thomas', claims_subscriber: true, player_code: wrong });
  assert.equal(r.body.error, 'subscriber_not_recognized');
  // Sans se déclarer abonné : prénom déjà pris → il doit se distinguer
  r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Thomas' });
  assert.equal(r.body.error, 'name_taken');

  // Aucune de ces tentatives n'a créé d'inscription à 5 €
  const v = (await admin('GET', `/api/admin/matches/${m.match.id}`)).body;
  assert.equal(v.registrations.length, 0);

  // Tarif normal ensuite : 10 €
  r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Menteur' });
  assert.equal(r.status, 201);
  assert.equal(r.body.registration.price_cents, 1000);
});

/* =========================================================
   Identification, homonymes, doublons
   ========================================================= */

test('homonymes : deux fiches distinctes, téléphone reconnu, doublon bloqué, fusion', async (t) => {
  const { admin, client } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = m.links.find((l) => l.level === 'open').token;

  // Premier Léo : fiche créée, le téléphone est mémorisé
  const phone1 = client();
  let r = await reg(phone1, m.match.id, { link_token: tok, first_name: 'léo' });
  assert.equal(r.status, 201);
  assert.equal(r.body.registration.first_name, 'Léo');
  assert.match(r.body.registration.player_code, /^\d{4}$/);
  assert.ok(phone1.jar.fdv_player, 'cookie téléphone posé');
  const cookieHeader = r.headers.getSetCookie().join(' ');
  assert.match(cookieHeader, /HttpOnly/);

  // Même téléphone : reconnu, ne peut pas s'inscrire deux fois
  const me = (await phone1.call('GET', `/api/public/links/${tok}`)).body.me;
  assert.equal(me.first_name, 'Léo');
  assert.ok(me.registration);
  r = await reg(phone1, m.match.id, { link_token: tok });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'already_registered');

  // Autre personne « Leo » sur un autre téléphone → doit se distinguer
  const phone2 = client();
  r = await reg(phone2, m.match.id, { link_token: tok, first_name: 'LEO' });
  assert.equal(r.body.error, 'name_taken');
  assert.match(r.body.message, /initiale/);
  r = await reg(phone2, m.match.id, { link_token: tok, first_name: 'Leo M.' });
  assert.equal(r.status, 201);

  // L'admin peut créer un vrai homonyme exact
  const add = await admin('POST', `/api/admin/matches/${m.match.id}/registrations`, { first_name: 'Léo', payment_method: 'cash' });
  assert.equal(add.status, 201);
  const leos = (await admin('GET', '/api/admin/players')).body.players.filter((p) => p.first_name === 'Léo');
  assert.equal(leos.length, 2, 'deux fiches Léo distinctes');
  assert.ok(leos.every((p) => p.homonyms));

  // Fusion : conflit si inscrits au même match
  const conflict = await admin('POST', `/api/admin/players/${leos[1].id}/merge`, { into_player_id: leos[0].id });
  assert.equal(conflict.status, 409);
  // On supprime l'inscription en double puis on fusionne
  const v = (await admin('GET', `/api/admin/matches/${m.match.id}`)).body;
  const dupReg = v.registrations.find((x) => x.player_id === leos[1].id);
  assert.equal((await admin('DELETE', `/api/admin/registrations/${dupReg.id}`, {})).status, 200);
  const merged = await admin('POST', `/api/admin/players/${leos[1].id}/merge`, { into_player_id: leos[0].id });
  assert.equal(merged.status, 200);
  assert.equal((await admin('GET', '/api/admin/players')).body.players.filter((p) => p.first_name === 'Léo').length, 1);

  // Inscrire quelqu'un d'autre depuis le téléphone de Léo ne remplace pas son identité
  r = await reg(phone1, m.match.id, { link_token: tok, first_name: 'Copain', as_other: true });
  assert.equal(r.status, 201);
  assert.equal((await phone1.call('GET', `/api/public/links/${tok}`)).body.me.first_name, 'Léo');
});

/* =========================================================
   Participations
   ========================================================= */

test('participations : seules les présences comptent, recalcul sans double comptage', async (t) => {
  const { admin, client } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = m.links.find((l) => l.level === 'open').token;
  const r = await reg(client(), m.match.id, { link_token: tok, first_name: 'Compteur' });
  const pid = (await admin('GET', '/api/admin/players')).body.players.find((p) => p.first_name === 'Compteur').id;
  const count = async () => (await admin('GET', `/api/admin/players/${pid}`)).body.player.participations;
  const regId = (await admin('GET', `/api/admin/matches/${m.match.id}`)).body.registrations.find((x) => x.player_id === pid).id;
  assert.equal(r.status, 201);

  assert.equal(await count(), 0, 'inscription seule');
  await admin('PATCH', `/api/admin/registrations/${regId}`, { attendance: 'absent' });
  assert.equal(await count(), 0, 'absent');
  await admin('PATCH', `/api/admin/registrations/${regId}`, { attendance: 'present' });
  assert.equal(await count(), 1, 'présent');
  await admin('PATCH', `/api/admin/registrations/${regId}`, { attendance: 'present' });
  await admin('PATCH', `/api/admin/registrations/${regId}`, { attendance: 'present' });
  assert.equal(await count(), 1, 'pas de double comptage');
  await admin('PATCH', `/api/admin/registrations/${regId}`, { attendance: 'absent' });
  assert.equal(await count(), 0, 'présent → absent recalculé');
  await admin('PATCH', `/api/admin/registrations/${regId}`, { attendance: 'present' });

  // Correction manuelle, puis une présence supplémentaire s'ajoute correctement
  await admin('PATCH', `/api/admin/players/${pid}`, { participations: 4 });
  assert.equal(await count(), 4);
  const m2 = await newMatch(admin, { status: 'open', date: '2099-06-12' });
  await admin('POST', `/api/admin/matches/${m2.match.id}/registrations`, { player_id: pid, payment_method: 'card' });
  const reg2 = (await admin('GET', `/api/admin/matches/${m2.match.id}`)).body.registrations[0];
  assert.equal(reg2.price_cents, 1000, '4 participations → 10 €');
  await admin('PATCH', `/api/admin/registrations/${reg2.id}`, { attendance: 'present' });
  assert.equal(await count(), 5);
});

/* =========================================================
   Capacité
   ========================================================= */

test('capacité : impossible de dépasser le maximum, même en simultané', async (t) => {
  const { admin, client } = await setup(t);
  const m = await newMatch(admin, { status: 'open', capacity: 5 });
  const tok = m.links.find((l) => l.level === 'open').token;
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    reg(client(), m.match.id, { link_token: tok, first_name: `Joueur${String.fromCharCode(65 + i)}` })));
  assert.equal(results.filter((r) => r.status === 201).length, 5);
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.body.error === 'full'));
  const v = (await admin('GET', `/api/admin/matches/${m.match.id}`)).body;
  assert.equal(v.stats.registered, 5);
  const add = await admin('POST', `/api/admin/matches/${m.match.id}/registrations`, { first_name: 'EnTrop', payment_method: 'cash' });
  assert.equal(add.body.error, 'full');
  const link = await client().call('GET', `/api/public/links/${tok}`);
  assert.equal(link.body.current.remaining, 0);
});

/* =========================================================
   Données publiques
   ========================================================= */

test('données publiques : ni paiement, ni statut, ni autres tokens, ni secrets', async (t) => {
  const { admin, client, current } = await setup(t);
  const tokens = current.links.map((l) => l.token);
  const phone = client();
  const responses = [
    await phone.call('GET', '/api/public/match'),
    await phone.call('GET', `/api/public/matches/${current.match.id}`),
    await phone.call('GET', `/api/public/links/${tokens[0]}`),
    await phone.call('GET', `/api/public/links/${tokens[1]}`),
  ];
  const codes = (await admin('GET', '/api/admin/players')).body.players.map((p) => p.code);
  for (const r of responses) {
    const raw = r.text;
    for (const leak of ['payment_status', 'paid', 'cash_due', 'to_pay', 'payment_method', 'payment_link', 'tier', 'attendance', 'subscription', 'session', 'password', 'hash', 'is_demo', 'code']) {
      assert.ok(!raw.includes(`"${leak}"`), `fuite publique du champ ${leak}`);
    }
    for (const tk of tokens) assert.ok(!raw.includes(tk), 'aucun token de lien exposé');
    for (const c of codes) assert.ok(!raw.includes(`"${c}"`), 'aucun code joueur exposé');
  }
  // Le lien général ne permet pas de s'inscrire
  const r = await reg(phone, current.match.id, { first_name: 'Malin' });
  assert.equal(r.body.error, 'invalid_link');
  // Route inexistante / admin inaccessible
  assert.equal((await phone.call('GET', '/api/admin/settings')).status, 401);
});

/* =========================================================
   Administration
   ========================================================= */

test('administration : tout est refusé sans authentification', async (t) => {
  const { client, P, current } = await setup(t);
  const anon = client();
  const checks = [
    ['GET', '/api/admin/overview'],
    ['GET', '/api/admin/players'],
    ['GET', `/api/admin/players/${P('Lucas').id}`],
    ['PATCH', `/api/admin/players/${P('Lucas').id}`, { subscription: 'annual' }],
    ['POST', `/api/admin/players/${P('Lucas').id}/merge`, { into_player_id: P('Hugo').id }],
    ['DELETE', `/api/admin/players/${P('Lucas').id}`, {}],
    ['POST', '/api/admin/players', { first_name: 'X' }],
    ['GET', `/api/admin/matches/${current.match.id}`],
    ['PATCH', `/api/admin/matches/${current.match.id}`, { status: 'invite' }],
    ['POST', '/api/admin/seasons', { name: 'Hack' }],
    ['PATCH', '/api/admin/registrations/1', { payment_status: 'paid' }],
    ['POST', '/api/admin/password', { current: 'x', next: 'yyyyyyyyyyyy' }],
  ];
  for (const [method, url, body] of checks) {
    const r = await anon.call(method, url, body);
    assert.equal(r.status, 401, `${method} ${url}`);
  }
  // Un faux cookie de session est refusé
  anon.jar.fdv_admin = 'eyJleHAiOjk5OTk5OTk5OTk5OTl9.fake';
  assert.equal((await anon.call('GET', '/api/admin/players')).status, 401);
});

test('administration : abonnement annuel manuel, retrait, mot de passe ≥ 10 caractères', async (t) => {
  const { admin, P } = await setup(t);
  const lucas = P('Lucas');
  let d = (await admin('PATCH', `/api/admin/players/${lucas.id}`, { subscription: 'annual' })).body;
  assert.equal(d.player.label, 'Abonné annuel');
  assert.equal(d.player.priority, true);
  assert.equal(d.player.price_cents, 500);
  d = (await admin('PATCH', `/api/admin/players/${lucas.id}`, { subscription: 'none' })).body;
  assert.equal(d.player.label, 'Non abonné');
  assert.equal(d.player.priority, false);
  d = (await admin('PATCH', `/api/admin/players/${lucas.id}`, { first_name: 'Lucas R.' })).body;
  assert.equal(d.player.first_name, 'Lucas R.');

  const short = await admin('POST', '/api/admin/password', { current: 'secret-test-password', next: 'court12' });
  assert.equal(short.status, 400);
  const ok = await admin('POST', '/api/admin/password', { current: 'secret-test-password', next: 'nouveau-mot-de-passe' });
  assert.equal(ok.status, 200);
});

/* =========================================================
   Historique et saisons
   ========================================================= */

test('historique : le tarif enregistré ne change pas quand le joueur devient abonné', async (t) => {
  const { admin, client, P } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = m.links.find((l) => l.level === 'open').token;
  await reg(client(), m.match.id, { link_token: tok, first_name: 'Lucas', player_code: P('Lucas').code });
  await admin('PATCH', `/api/admin/players/${P('Lucas').id}`, { subscription: 'annual' });
  const v = (await admin('GET', `/api/admin/matches/${m.match.id}`)).body;
  const r = v.registrations.find((x) => x.player_id === P('Lucas').id);
  assert.equal(r.price_cents, 1000);
  assert.equal(r.tier_label, 'Non abonné');
  const hist = (await admin('GET', `/api/admin/players/${P('Lucas').id}`)).body.history;
  assert.equal(hist.find((h) => h.match_id === m.match.id).price_cents, 1000);
});

test('saisons : nouvelle saison = compteurs à zéro, anciennes données conservées', async (t) => {
  const { admin, P } = await setup(t);
  const before = (await admin('GET', '/api/admin/matches')).body.matches;
  const thomasBefore = (await admin('GET', `/api/admin/players/${P('Thomas').id}`)).body;
  const oldSeasonId = thomasBefore.season_id;

  const s = await admin('POST', '/api/admin/seasons', { name: '2027–2028', carry_annual: true });
  assert.equal(s.status, 201);
  assert.equal(s.body.seasons.length, 2);

  const after = (await admin('GET', '/api/admin/matches')).body.matches;
  assert.equal(after.length, before.length, 'aucun match supprimé');
  const hugo = (await admin('GET', `/api/admin/players/${P('Hugo').id}`)).body;
  assert.equal(hugo.player.participations, 0, 'compteur remis à zéro');
  assert.equal(hugo.player.label, 'Non abonné', 'fidélité remise à zéro');
  const oldHugo = hugo.seasons.find((x) => x.id === oldSeasonId);
  assert.equal(oldHugo.label, 'Abonné fidélité', 'ancien statut conservé');
  assert.equal(oldHugo.participations, 7, 'anciennes participations conservées');
  assert.ok(hugo.history.length >= 3, 'historique conservé');
  const thomas = (await admin('GET', `/api/admin/players/${P('Thomas').id}`)).body;
  assert.equal(thomas.player.label, 'Abonné annuel', 'abonnés annuels reconduits sur demande');
  assert.equal(thomas.history.length, thomasBefore.history.length);
});

/* =========================================================
   Sécurité HTML / en-têtes
   ========================================================= */

test('en-têtes de sécurité et prénoms malveillants stockés tels quels (rendus via textContent)', async (t) => {
  const { admin, client, base } = await setup(t);
  const m = await newMatch(admin, { status: 'open' });
  const tok = m.links.find((l) => l.level === 'open').token;
  const r = await reg(client(), m.match.id, { link_token: tok, first_name: '<img src=x onerror=1>Bob' });
  assert.equal(r.status, 201);
  const page = await fetch(`${base}/i/${tok}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  // Le front-end n'utilise jamais innerHTML avec des données utilisateur
  const src = ['player.js', 'admin.js', 'common.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')).join('\n');
  assert.ok(!/innerHTML\s*=\s*(?!v;)/.test(src.replace(/el\.innerHTML = v; \/\/ réservé aux icônes SVG internes/, '')), 'innerHTML réservé aux icônes internes');
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
  const tok = m.links.find((l) => l.level === 'open').token;
  const signup = (name, extra = {}) => reg(ctx.client(), m.match.id, {
    link_token: tok, first_name: name, player_code: ctx.P(name)?.code, ...extra,
  });
  return { ...ctx, m, tok, signup };
}

test('lien carte : 5 € pour abonnés annuels, fidélité et fidélité acquise ; 10 € pour les autres', async (t) => {
  const { signup } = await withLinks(t);
  const cases = [
    ['Thomas', 500, L5],   // abonné annuel
    ['Hugo', 500, L5],     // abonné fidélité
    ['Antoine', 500, L5],  // 5 participations → 6e inscription
    ['Lucas', 1000, L10],  // 3 participations
    ['Maxime', 1000, L10], // 4 participations
    ['Inconnu', 1000, L10],
  ];
  for (const [name, price, link] of cases) {
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
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.registration.price_cents, 1000);
  assert.equal(r.body.payment_link, L10);
  const v = (await admin('GET', `/api/admin/matches/${m.match.id}`)).body.registrations.find((x) => x.first_name === 'Tricheur');
  assert.equal(v.price_cents, 1000);
  assert.equal(v.payment_status, 'to_pay');
});

test('lien carte : lien manquant → aucun lien, jamais celui de l’autre montant', async (t) => {
  // Lien 5 € absent
  let ctx = await withLinks(t, { 500: '', 1000: L10 });
  let r = await ctx.signup('Thomas');
  assert.equal(r.body.registration.price_cents, 500);
  assert.equal(r.body.payment_link, '');
  r = await ctx.signup('Lucas');
  assert.equal(r.body.payment_link, L10);
  const ov = (await ctx.admin('GET', '/api/admin/overview')).body;
  assert.deepEqual(ov.warnings.missing_card_links, [500]);

  // Lien 10 € absent
  ctx = await withLinks(t, { 500: L5, 1000: '' });
  r = await ctx.signup('Lucas');
  assert.equal(r.body.registration.price_cents, 1000);
  assert.equal(r.body.payment_link, '');
  r = await ctx.signup('Thomas');
  assert.equal(r.body.payment_link, L5);
});

test('lien carte : aucun lien pour un paiement en espèces, ni dans la confirmation retrouvée', async (t) => {
  const { client, m, tok, P } = await withLinks(t);
  const phone = client();
  const r = await reg(phone, m.match.id, { link_token: tok, first_name: 'Thomas', player_code: P('Thomas').code, payment_method: 'cash' });
  assert.equal(r.status, 201);
  assert.equal(r.body.payment_link, '');
  assert.ok(!r.text.includes(L5) && !r.text.includes(L10));
  const again = await phone.call('GET', `/api/public/links/${tok}`);
  assert.equal(again.body.me.registration.payment_link, '');
  assert.equal(again.body.me.registration.price_cents, 500);
});

test('lien carte : jamais exposé aux autres, et tarif historique conservé', async (t) => {
  const { client, admin, m, tok, P } = await withLinks(t);
  // Un visiteur non inscrit ne voit aucun lien bancaire
  for (const url of ['/api/public/match', `/api/public/links/${tok}`, `/api/public/matches/${m.match.id}`]) {
    const x = await client().call('GET', url);
    assert.ok(!x.text.includes(L5) && !x.text.includes(L10), url);
  }
  // Lucas s'inscrit à 10 € puis devient abonné : l'ancien match garde 10 € et le lien 10 €
  const lucasPhone = client();
  let r = await reg(lucasPhone, m.match.id, { link_token: tok, first_name: 'Lucas', player_code: P('Lucas').code });
  assert.equal(r.body.payment_link, L10);
  await admin('PATCH', `/api/admin/players/${P('Lucas').id}`, { subscription: 'loyalty' });
  const old = await lucasPhone.call('GET', `/api/public/links/${tok}`);
  assert.equal(old.body.me.registration.price_cents, 1000);
  assert.equal(old.body.me.registration.payment_link, L10);
  const hist = (await admin('GET', `/api/admin/players/${P('Lucas').id}`)).body.history.find((x) => x.match_id === m.match.id);
  assert.equal(hist.price_cents, 1000);
  // Match suivant : nouveau tarif 5 € et lien 5 €
  const m2 = await newMatch(admin, { status: 'open', date: '2099-06-12' });
  r = await reg(lucasPhone, m2.match.id, { link_token: m2.links.find((l) => l.level === 'open').token });
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
