'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { today, addDays, nextFriday } = require('./dates');

/* =========================================================
   Utilitaires partagés
   ========================================================= */

function normalizeName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Jeton de lien : 32 octets aléatoires (256 bits), encodés en base64url (43 caractères). */
function newLinkToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Nom de saison pour une date : la saison démarre en août (ex. « 2026–2027 »). */
function seasonFor(isoDate) {
  const [y, m] = isoDate.split('-').map(Number);
  const start = m >= 8 ? y : y - 1;
  return { name: `${start}–${start + 1}`, start_date: `${start}-09-01` };
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/**
 * ANCIEN SYSTÈME (supprimé en v5) — utilisé uniquement par les migrations historiques v2/v3,
 * tant que la colonne `players.code` existe encore. L'application ne l'utilise plus.
 */
function legacyPlayerCode(db, nameKey) {
  const taken = new Set(db.prepare('SELECT code FROM players WHERE name_key = ?').all(nameKey).map((r) => r.code));
  for (let i = 0; i < 200; i++) {
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!taken.has(code)) return code;
  }
  throw new Error('Impossible de générer un code joueur');
}

/**
 * Crée une fiche joueur. `phone` doit être déjà normalisé (+33…) ou null.
 * L'unicité du numéro est garantie par l'index UNIQUE idx_players_phone.
 */
function createPlayer(db, { first_name, season_id, subscription = 'none', adjustment = 0, is_demo = 0, created_at = null, phone = null, needs_review = 0 }) {
  const key = normalizeName(first_name);
  const cols = ['first_name', 'name_key', 'is_demo', 'created_season_id'];
  const vals = [first_name, key, is_demo, season_id];
  if (created_at) { cols.push('created_at'); vals.push(created_at); }
  if (hasColumn(db, 'players', 'code')) { cols.push('code'); vals.push(legacyPlayerCode(db, key)); } // migrations historiques uniquement
  if (hasColumn(db, 'players', 'phone_normalized')) {
    cols.push('phone_normalized', 'needs_review');
    vals.push(phone, needs_review ? 1 : 0);
  }
  const r = db.prepare(`INSERT INTO players (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  const id = Number(r.lastInsertRowid);
  db.prepare(`INSERT INTO player_seasons (player_id, season_id, subscription, subscribed_at, participations_adjustment)
              VALUES (?, ?, ?, ?, ?)`)
    .run(id, season_id, subscription, subscription === 'none' ? null : new Date().toISOString(), adjustment);
  return id;
}

/** Crée les trois liens (Prioritaires / Ouvert / Invitations) d'un match s'ils n'existent pas. */
function ensureMatchLinks(db, matchId) {
  const ins = db.prepare('INSERT OR IGNORE INTO match_links (match_id, level, token) VALUES (?, ?, ?)');
  for (const level of ['priority', 'open', 'invite']) ins.run(matchId, level, newLinkToken());
}

function currentSeasonId(db) {
  const s = db.prepare('SELECT id FROM seasons WHERE is_current = 1 ORDER BY id DESC LIMIT 1').get();
  return s ? s.id : null;
}

/* =========================================================
   Migrations (jouées une seule fois, dans l'ordre)
   Chaque entrée est soit du SQL, soit une fonction (migration de données).
   ========================================================= */

const MIGRATIONS = [
  // v1 — schéma initial
  `
  CREATE TABLE matches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    date          TEXT    NOT NULL,              -- YYYY-MM-DD
    time          TEXT    NOT NULL,              -- HH:MM
    location      TEXT    NOT NULL,
    price_cents   INTEGER NOT NULL DEFAULT 0,
    capacity      INTEGER NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'priority'
                  CHECK (status IN ('draft','priority','open','invite','closed')),
    payment_link  TEXT    NOT NULL DEFAULT '',
    is_demo       INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_matches_date ON matches(date);

  CREATE TABLE registrations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id        INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    first_name      TEXT    NOT NULL,
    name_key        TEXT    NOT NULL,            -- prénom normalisé (anti-doublon)
    payment_method  TEXT    NOT NULL CHECK (payment_method IN ('card','cash')),
    payment_status  TEXT    NOT NULL CHECK (payment_status IN ('to_pay','paid','cash_due')),
    source          TEXT    NOT NULL DEFAULT 'player' CHECK (source IN ('player','admin')),
    token           TEXT    NOT NULL,            -- permet au joueur de retrouver SON inscription
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    paid_at         TEXT
  );
  CREATE INDEX idx_reg_match ON registrations(match_id, created_at);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // v2 — joueurs persistants, saisons, abonnements, présences, tarifs individuels, liens sécurisés
  `
  CREATE TABLE seasons (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    start_date  TEXT    NOT NULL,
    is_current  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE players (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name         TEXT    NOT NULL,
    name_key           TEXT    NOT NULL,
    code               TEXT    NOT NULL,          -- code joueur (4 chiffres) pour se faire reconnaître sur un nouveau téléphone
    is_demo            INTEGER NOT NULL DEFAULT 0,
    created_season_id  INTEGER REFERENCES seasons(id),
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_players_name ON players(name_key);

  -- Statut d'un joueur pour une saison (les anciennes saisons restent intactes)
  CREATE TABLE player_seasons (
    player_id                  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    season_id                  INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    subscription               TEXT    NOT NULL DEFAULT 'none' CHECK (subscription IN ('none','annual','loyalty')),
    subscribed_at              TEXT,
    participations_adjustment  INTEGER NOT NULL DEFAULT 0,   -- correction manuelle de l'organisateur
    PRIMARY KEY (player_id, season_id)
  );

  -- Téléphones reconnus (cookie aléatoire, seul son empreinte SHA-256 est stockée)
  CREATE TABLE player_devices (
    token_hash    TEXT PRIMARY KEY,
    player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen_at  TEXT
  );
  CREATE INDEX idx_devices_player ON player_devices(player_id);

  -- Liens d'inscription par niveau d'accès
  CREATE TABLE match_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    level       TEXT    NOT NULL CHECK (level IN ('priority','open','invite')),
    token       TEXT    NOT NULL UNIQUE,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (match_id, level)
  );

  ALTER TABLE matches ADD COLUMN season_id INTEGER REFERENCES seasons(id);
  ALTER TABLE matches ADD COLUMN subscriber_price_cents INTEGER NOT NULL DEFAULT 500;

  ALTER TABLE registrations ADD COLUMN player_id INTEGER REFERENCES players(id);
  ALTER TABLE registrations ADD COLUMN price_cents INTEGER;
  ALTER TABLE registrations ADD COLUMN tier TEXT NOT NULL DEFAULT 'standard'
    CHECK (tier IN ('annual','loyalty','loyalty_upgrade','standard'));
  ALTER TABLE registrations ADD COLUMN attendance TEXT NOT NULL DEFAULT 'unknown'
    CHECK (attendance IN ('unknown','present','absent'));
  ALTER TABLE registrations ADD COLUMN attendance_at TEXT;
  `,

  // v2 (suite) — migration des données existantes vers le nouveau modèle
  (db) => {
    const first = db.prepare('SELECT MIN(date) AS d FROM matches').get().d || today();
    const s = seasonFor(first <= today() ? first : today());
    const seasonId = Number(db.prepare('INSERT INTO seasons (name, start_date, is_current) VALUES (?, ?, 1)').run(s.name, s.start_date).lastInsertRowid);
    db.prepare('UPDATE matches SET season_id = ?').run(seasonId);
    db.prepare('UPDATE registrations SET price_cents = (SELECT price_cents FROM matches WHERE matches.id = registrations.match_id)').run();

    // Une fiche joueur par prénom ; deux homonymes inscrits au même match deviennent deux fiches.
    const regs = db.prepare(`SELECT r.id, r.match_id, r.first_name, r.name_key, r.created_at, m.is_demo
                             FROM registrations r JOIN matches m ON m.id = r.match_id ORDER BY r.created_at, r.id`).all();
    const byKey = new Map();      // name_key -> [playerId…]
    const inMatch = new Set();    // `${match}:${player}`
    const setPlayer = db.prepare('UPDATE registrations SET player_id = ? WHERE id = ?');
    for (const r of regs) {
      const ids = byKey.get(r.name_key) || [];
      let pid = ids.find((id) => !inMatch.has(`${r.match_id}:${id}`));
      if (!pid) {
        const name = ids.length ? `${r.first_name} (${ids.length + 1})` : r.first_name;
        pid = createPlayer(db, { first_name: name, season_id: seasonId, is_demo: r.is_demo, created_at: r.created_at });
        ids.push(pid);
        byKey.set(r.name_key, ids);
      }
      inMatch.add(`${r.match_id}:${pid}`);
      setPlayer.run(pid, r.id);
    }
    for (const m of db.prepare('SELECT id FROM matches').all()) ensureMatchLinks(db, m.id);
    db.exec('CREATE UNIQUE INDEX idx_reg_player_match ON registrations(match_id, player_id)');
  },

  // v3 — si la base ne contient QUE la démo de la v1, on la remplace par la nouvelle démo (voir seedDemo).
  (db) => {
    const total = db.prepare('SELECT COUNT(*) AS n FROM matches').get().n;
    const real = db.prepare('SELECT COUNT(*) AS n FROM matches WHERE is_demo = 0').get().n;
    const realPlayers = db.prepare('SELECT COUNT(*) AS n FROM players WHERE is_demo = 0').get().n;
    if (total > 0 && real === 0 && realPlayers === 0) {
      db.exec('DELETE FROM registrations; DELETE FROM matches; DELETE FROM player_devices; DELETE FROM player_seasons; DELETE FROM players;');
      db.prepare("INSERT INTO settings (key, value) VALUES ('demo_reseed', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    }
  },

  // v5 — identification par numéro de téléphone : fin du code joueur et de la reconnaissance par cookie.
  //      Aucune fiche n'est fusionnée ni supprimée ; aucune donnée d'inscription n'est modifiée.
  (db) => {
    db.exec(`
      ALTER TABLE players ADD COLUMN phone_normalized TEXT;           -- +33612345678 ; NULL = numéro à renseigner
      CREATE UNIQUE INDEX idx_players_phone ON players(phone_normalized);
      ALTER TABLE players ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0; -- fiche à vérifier (doublon possible d'une ancienne fiche)
      ALTER TABLE players DROP COLUMN code;
      DROP TABLE IF EXISTS player_devices;
    `);
    // Seules les fiches de démonstration reçoivent un numéro (fictif, plage réservée) ; les vraies fiches restent « numéro à renseigner ».
    const setPhone = db.prepare('UPDATE players SET phone_normalized = ? WHERE id = ? AND phone_normalized IS NULL');
    const taken = db.prepare('SELECT 1 FROM players WHERE phone_normalized = ?');
    for (const [name, , , , phone] of DEMO_PLAYERS) {
      const p = db.prepare('SELECT id FROM players WHERE is_demo = 1 AND first_name = ? AND phone_normalized IS NULL ORDER BY id LIMIT 1').get(name);
      if (p && !taken.get(phone)) setPhone.run(phone, p.id);
    }
  },
];

/** `untilVersion` sert uniquement aux tests de migration (ouvrir une base « ancienne version »). */
function openDatabase(file, { untilVersion = MIGRATIONS.length } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db, untilVersion);
  return db;
}

function migrate(db, untilVersion = MIGRATIONS.length) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < Math.min(untilVersion, MIGRATIONS.length); v++) {
    db.exec('BEGIN');
    try {
      const m = MIGRATIONS[v];
      if (typeof m === 'function') m(db);
      else db.exec(m);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  // Toujours au moins une saison courante
  if (!currentSeasonId(db)) {
    const s = seasonFor(today());
    db.prepare('INSERT INTO seasons (name, start_date, is_current) VALUES (?, ?, 1)').run(s.name, s.start_date);
  }
}

/* =========================================================
   Données de démonstration
   ========================================================= */

/**
 * Profils de démo : [prénom, abonnement, participations antérieures au site, présences sur les 3 matchs passés]
 *   P = présent, A = absent, - = pas inscrit
 */
const DEMO_PLAYERS = [
  // Numéros FICTIFS : plage 06 39 98 xx xx réservée par l'ARCEP aux œuvres de fiction / tests.
  ['Thomas', 'annual', 9, 'PPP', '+33639980001'],   // Abonné annuel — 12 participations
  ['Bastien', 'annual', 2, 'PAP', '+33639980002'],  // Abonné annuel
  ['Hugo', 'loyalty', 4, 'PPP', '+33639980003'],    // Abonné fidélité — 7 participations
  ['Antoine', 'none', 2, 'PPP', '+33639980004'],    // Non abonné — 5 participations : prochaine inscription à 5 € (fidélité)
  ['Maxime', 'none', 2, 'PAP', '+33639980005'],     // Non abonné — 4 / 5
  ['Lucas', 'none', 0, 'PPP', '+33639980006'],      // Non abonné — 3 / 5
  ['Julien', 'none', 0, 'P-P', '+33639980007'],
  ['Karim', 'none', 0, '-PP', '+33639980008'],
  ['Nico', 'none', 0, 'PP-', '+33639980009'],
  ['Romain', 'none', 0, 'PPP', '+33639980010'],
  ['Yanis', 'none', 0, 'P-P', '+33639980011'],
  ['Mehdi', 'none', 0, 'PPA', '+33639980012'],
  ['Pierre', 'none', 0, 'P--', '+33639980013'],
  ['Sam', 'none', 0, '-P-', '+33639980014'],
];

/** Match de la semaine (phase Prioritaires) : seuls des prioritaires sont déjà inscrits. */
const DEMO_CURRENT = [
  ['Hugo', 'card', 'paid', '09:40'],
  ['Bastien', 'cash', 'cash_due', '12:05'],
];

/** Convertit une heure locale Paris (jour + HH:MM) en ISO UTC — approximation été (UTC+2) suffisante pour la démo. */
function parisToIso(day, hhmm) {
  return new Date(`${day}T${hhmm}:00+02:00`).toISOString();
}

function seedDemo(db, { force = false } = {}) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM matches').get().n;
  const reseed = getSetting(db, 'demo_reseed') === '1';
  if ((count > 0 || (getSetting(db, 'demo_seeded') === '1' && !reseed)) && !force) return false;

  const seasonId = currentSeasonId(db);
  const link = getSetting(db, 'default_payment_link', '');
  const demoDay = today() <= '2026-10-02' ? '2026-10-02' : nextFriday();

  const insertMatch = db.prepare(`INSERT INTO matches (date, time, location, price_cents, subscriber_price_cents, capacity, status, payment_link, is_demo, season_id, created_at)
                                  VALUES (?, '20:00', 'UrbanSoccer Nice', 1000, 500, 14, ?, ?, 1, ?, ?)`);
  const insertReg = db.prepare(`INSERT INTO registrations
      (match_id, player_id, first_name, name_key, payment_method, payment_status, source, token, created_at, paid_at, price_cents, tier, attendance, attendance_at)
      VALUES (?, ?, ?, ?, ?, ?, 'player', ?, ?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN');
  try {
    const ids = {};
    for (const [name, sub, adj, , phone] of DEMO_PLAYERS) {
      const free = !db.prepare('SELECT 1 FROM players WHERE phone_normalized = ?').get(phone);
      ids[name] = createPlayer(db, { first_name: name, season_id: seasonId, subscription: sub, adjustment: adj, is_demo: 1, phone: free ? phone : null });
    }
    const subOf = Object.fromEntries(DEMO_PLAYERS.map(([n, s]) => [n, s]));
    const tierOf = (n) => (subOf[n] === 'none' ? 'standard' : subOf[n]);
    const priceOf = (n) => (subOf[n] === 'none' ? 1000 : 500);

    // Historique : les trois vendredis précédents (plus ancien = index 2)
    for (let i = 2; i >= 0; i--) {
      const day = addDays(demoDay, -7 * (i + 1));
      const openDay = addDays(day, -4);
      const m = Number(insertMatch.run(day, 'closed', link, seasonId, parisToIso(openDay, '09:00')).lastInsertRowid);
      ensureMatchLinks(db, m);
      let j = 0;
      for (const [name, , , pattern] of DEMO_PLAYERS) {
        const mark = pattern[2 - i];
        if (mark === '-') continue;
        const at = parisToIso(openDay, `${String(9 + Math.floor(j / 3)).padStart(2, '0')}:${String((j * 11) % 60).padStart(2, '0')}`);
        const present = mark === 'P';
        const method = j % 3 === 1 ? 'cash' : 'card';
        insertReg.run(m, ids[name], name, normalizeName(name), method, present ? 'paid' : (method === 'cash' ? 'cash_due' : 'to_pay'),
          crypto.randomBytes(12).toString('hex'), at, present ? at : null, priceOf(name), tierOf(name),
          present ? 'present' : 'absent', parisToIso(day, '22:30'));
        j++;
      }
    }

    // Match de la semaine — phase Prioritaires
    const openDay = addDays(demoDay, -4) < today() ? addDays(demoDay, -4) : today();
    const m = Number(insertMatch.run(demoDay, 'priority', link, seasonId, parisToIso(openDay, '08:00')).lastInsertRowid);
    ensureMatchLinks(db, m);
    for (const [name, method, status, hhmm] of DEMO_CURRENT) {
      const at = new Date(Math.min(Date.parse(parisToIso(openDay, hhmm)), Date.now() - 60000)).toISOString();
      insertReg.run(m, ids[name], name, normalizeName(name), method, status, crypto.randomBytes(12).toString('hex'),
        at, status === 'paid' ? at : null, priceOf(name), tierOf(name), 'unknown', null);
    }
    setSetting(db, 'demo_seeded', '1');
    setSetting(db, 'demo_reseed', '0');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}

/* =========================================================
   Paramètres
   ========================================================= */

function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

module.exports = {
  openDatabase,
  seedDemo,
  getSetting,
  setSetting,
  normalizeName,
  createPlayer,
  ensureMatchLinks,
  currentSeasonId,
  DEMO_PLAYERS,
  seasonFor,
};
