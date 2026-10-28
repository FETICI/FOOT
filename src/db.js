'use strict';
const crypto = require('node:crypto');
const { Pool } = require('pg');
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

/* =========================================================
   Connexion PostgreSQL
   ========================================================= */

let _pool = null;

function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
        ? { rejectUnauthorized: false }
        : false,
    });
  }
  return _pool;
}

/**
 * Client synchrone-like via wrapper async.
 * Pour maintenir la compatibilité avec le reste du code (qui était synchrone),
 * on expose un objet db avec les méthodes prepare/exec qui retournent des proxies.
 *
 * En réalité, toutes les fonctions qui utilisent db doivent être async ou utiliser
 * le client directement. On va adopter une approche : un Client PostgreSQL bloquant
 * simulé via un pool + async/await partout.
 */

/**
 * Ouvre (initialise) la base PostgreSQL et joue les migrations.
 * Retourne un objet "db" avec les méthodes nécessaires.
 */
async function openDatabase() {
  const pool = getPool();
  await migrate(pool);
  return pool;
}

/* =========================================================
   Schéma PostgreSQL
   ========================================================= */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS matches (
    id                      SERIAL PRIMARY KEY,
    date                    TEXT    NOT NULL,
    time                    TEXT    NOT NULL,
    location                TEXT    NOT NULL,
    price_cents             INTEGER NOT NULL DEFAULT 0,
    capacity                INTEGER NOT NULL,
    status                  TEXT    NOT NULL DEFAULT 'priority'
                            CHECK (status IN ('draft','priority','open','invite','closed')),
    payment_link            TEXT    NOT NULL DEFAULT '',
    is_demo                 INTEGER NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    season_id               INTEGER,
    subscriber_price_cents  INTEGER NOT NULL DEFAULT 500
  );
  CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(date);

  CREATE TABLE IF NOT EXISTS registrations (
    id              SERIAL PRIMARY KEY,
    match_id        INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    first_name      TEXT    NOT NULL,
    name_key        TEXT    NOT NULL,
    payment_method  TEXT    NOT NULL CHECK (payment_method IN ('card','cash')),
    payment_status  TEXT    NOT NULL CHECK (payment_status IN ('to_pay','paid','cash_due')),
    source          TEXT    NOT NULL DEFAULT 'player' CHECK (source IN ('player','admin')),
    token           TEXT    NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at         TIMESTAMPTZ,
    player_id       INTEGER,
    price_cents     INTEGER,
    tier            TEXT    NOT NULL DEFAULT 'standard'
                    CHECK (tier IN ('annual','loyalty','loyalty_upgrade','standard')),
    attendance      TEXT    NOT NULL DEFAULT 'unknown'
                    CHECK (attendance IN ('unknown','present','absent')),
    attendance_at   TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_reg_match ON registrations(match_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_player_match ON registrations(match_id, player_id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seasons (
    id          SERIAL PRIMARY KEY,
    name        TEXT    NOT NULL,
    start_date  TEXT    NOT NULL,
    is_current  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS players (
    id                 SERIAL PRIMARY KEY,
    first_name         TEXT    NOT NULL,
    name_key           TEXT    NOT NULL,
    is_demo            INTEGER NOT NULL DEFAULT 0,
    created_season_id  INTEGER REFERENCES seasons(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    phone_normalized   TEXT UNIQUE,
    needs_review       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_players_name ON players(name_key);

  CREATE TABLE IF NOT EXISTS player_seasons (
    player_id                  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    season_id                  INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    subscription               TEXT    NOT NULL DEFAULT 'none' CHECK (subscription IN ('none','annual','loyalty')),
    subscribed_at              TIMESTAMPTZ,
    participations_adjustment  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (player_id, season_id)
  );

  CREATE TABLE IF NOT EXISTS match_links (
    id          SERIAL PRIMARY KEY,
    match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    level       TEXT    NOT NULL CHECK (level IN ('priority','open','invite')),
    token       TEXT    NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (match_id, level)
  );

  CREATE TABLE IF NOT EXISTS teams (
    id          SERIAL PRIMARY KEY,
    match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE UNIQUE,
    data        JSONB   NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  ALTER TABLE matches ADD COLUMN IF NOT EXISTS season_id INTEGER REFERENCES seasons(id);
  ALTER TABLE matches ADD COLUMN IF NOT EXISTS subscriber_price_cents INTEGER NOT NULL DEFAULT 500;
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS player_id INTEGER REFERENCES players(id);
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS price_cents INTEGER;
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'standard';
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS attendance TEXT NOT NULL DEFAULT 'unknown';
  ALTER TABLE registrations ADD COLUMN IF NOT EXISTS attendance_at TIMESTAMPTZ;
`;

async function migrate(pool) {
  await pool.query(SCHEMA);

  // Assurer qu'il y a toujours une saison courante
  const { rows } = await pool.query(`SELECT id FROM seasons WHERE is_current = 1 ORDER BY id DESC LIMIT 1`);
  if (rows.length === 0) {
    const s = seasonFor(today());
    await pool.query(`INSERT INTO seasons (name, start_date, is_current) VALUES ($1, $2, 1)`, [s.name, s.start_date]);
  }
}

/* =========================================================
   Helpers pour créer des joueurs / liens
   ========================================================= */

async function createPlayer(pool, { first_name, season_id, subscription = 'none', adjustment = 0, is_demo = 0, created_at = null, phone = null, needs_review = 0 }) {
  const key = normalizeName(first_name);
  let res;
  if (created_at) {
    res = await pool.query(
      `INSERT INTO players (first_name, name_key, is_demo, created_season_id, phone_normalized, needs_review, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [first_name, key, is_demo, season_id, phone, needs_review ? 1 : 0, created_at]
    );
  } else {
    res = await pool.query(
      `INSERT INTO players (first_name, name_key, is_demo, created_season_id, phone_normalized, needs_review)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [first_name, key, is_demo, season_id, phone, needs_review ? 1 : 0]
    );
  }
  const id = res.rows[0].id;
  await pool.query(
    `INSERT INTO player_seasons (player_id, season_id, subscription, subscribed_at, participations_adjustment)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [id, season_id, subscription, subscription === 'none' ? null : new Date().toISOString(), adjustment]
  );
  return id;
}

async function ensureMatchLinks(pool, matchId) {
  for (const level of ['priority', 'open', 'invite']) {
    await pool.query(
      `INSERT INTO match_links (match_id, level, token) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [matchId, level, newLinkToken()]
    );
  }
}

async function currentSeasonId(pool) {
  const { rows } = await pool.query(`SELECT id FROM seasons WHERE is_current = 1 ORDER BY id DESC LIMIT 1`);
  return rows.length ? rows[0].id : null;
}

/* =========================================================
   Données de démonstration
   ========================================================= */

const DEMO_PLAYERS = [
  ['Thomas', 'annual', 9, 'PPP', '+33639980001'],
  ['Bastien', 'annual', 2, 'PAP', '+33639980002'],
  ['Hugo', 'loyalty', 4, 'PPP', '+33639980003'],
  ['Antoine', 'none', 2, 'PPP', '+33639980004'],
  ['Maxime', 'none', 2, 'PAP', '+33639980005'],
  ['Lucas', 'none', 0, 'PPP', '+33639980006'],
  ['Julien', 'none', 0, 'P-P', '+33639980007'],
  ['Karim', 'none', 0, '-PP', '+33639980008'],
  ['Nico', 'none', 0, 'PP-', '+33639980009'],
  ['Romain', 'none', 0, 'PPP', '+33639980010'],
  ['Yanis', 'none', 0, 'P-P', '+33639980011'],
  ['Mehdi', 'none', 0, 'PPA', '+33639980012'],
  ['Pierre', 'none', 0, 'P--', '+33639980013'],
  ['Sam', 'none', 0, '-P-', '+33639980014'],
];

const DEMO_CURRENT = [
  ['Hugo', 'card', 'paid', '09:40'],
  ['Bastien', 'cash', 'cash_due', '12:05'],
];

function parisToIso(day, hhmm) {
  return new Date(`${day}T${hhmm}:00+02:00`).toISOString();
}

async function seedDemo(pool, { force = false } = {}) {
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS n FROM matches`);
  const count = parseInt(countRows[0].n);
  const reseed = (await getSetting(pool, 'demo_reseed')) === '1';
  const seeded = (await getSetting(pool, 'demo_seeded')) === '1';
  if ((count > 0 || (seeded && !reseed)) && !force) return false;

  const seasonId = await currentSeasonId(pool);
  const link = (await getSetting(pool, 'default_payment_link')) || '';
  const demoDay = today() <= '2026-10-02' ? '2026-10-02' : nextFriday();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = {};
    for (const [name, sub, adj, , phone] of DEMO_PLAYERS) {
      const { rows: ex } = await client.query(`SELECT 1 FROM players WHERE phone_normalized = $1`, [phone]);
      const pPhone = ex.length ? null : phone;
      ids[name] = await createPlayer(client, { first_name: name, season_id: seasonId, subscription: sub, adjustment: adj, is_demo: 1, phone: pPhone });
    }
    const subOf = Object.fromEntries(DEMO_PLAYERS.map(([n, s]) => [n, s]));
    const tierOf = (n) => (subOf[n] === 'none' ? 'standard' : subOf[n]);
    const priceOf = (n) => (subOf[n] === 'none' ? 1000 : 500);

    for (let i = 2; i >= 0; i--) {
      const day = addDays(demoDay, -7 * (i + 1));
      const openDay = addDays(day, -4);
      const { rows: mr } = await client.query(
        `INSERT INTO matches (date, time, location, price_cents, subscriber_price_cents, capacity, status, payment_link, is_demo, season_id, created_at)
         VALUES ($1,'20:00','UrbanSoccer Nice',1000,500,14,'closed',$2,1,$3,$4) RETURNING id`,
        [day, link, seasonId, parisToIso(openDay, '09:00')]
      );
      const m = mr[0].id;
      await ensureMatchLinks(client, m);
      let j = 0;
      for (const [name, , , pattern] of DEMO_PLAYERS) {
        const mark = pattern[2 - i];
        if (mark === '-') continue;
        const at = parisToIso(openDay, `${String(9 + Math.floor(j / 3)).padStart(2, '0')}:${String((j * 11) % 60).padStart(2, '0')}`);
        const present = mark === 'P';
        const method = j % 3 === 1 ? 'cash' : 'card';
        await client.query(
          `INSERT INTO registrations (match_id, player_id, first_name, name_key, payment_method, payment_status, source, token, created_at, paid_at, price_cents, tier, attendance, attendance_at)
           VALUES ($1,$2,$3,$4,$5,$6,'player',$7,$8,$9,$10,$11,$12,$13)`,
          [m, ids[name], name, normalizeName(name), method,
            present ? 'paid' : (method === 'cash' ? 'cash_due' : 'to_pay'),
            crypto.randomBytes(12).toString('hex'), at, present ? at : null,
            priceOf(name), tierOf(name), present ? 'present' : 'absent',
            parisToIso(day, '22:30')]
        );
        j++;
      }
    }

    const openDay = addDays(demoDay, -4) < today() ? addDays(demoDay, -4) : today();
    const { rows: mr2 } = await client.query(
      `INSERT INTO matches (date, time, location, price_cents, subscriber_price_cents, capacity, status, payment_link, is_demo, season_id, created_at)
       VALUES ($1,'20:00','UrbanSoccer Nice',1000,500,14,'priority',$2,1,$3,$4) RETURNING id`,
      [demoDay, link, seasonId, parisToIso(openDay, '08:00')]
    );
    const m2 = mr2[0].id;
    await ensureMatchLinks(client, m2);
    for (const [name, method, status, hhmm] of DEMO_CURRENT) {
      const at = new Date(Math.min(Date.parse(parisToIso(openDay, hhmm)), Date.now() - 60000)).toISOString();
      await client.query(
        `INSERT INTO registrations (match_id, player_id, first_name, name_key, payment_method, payment_status, source, token, created_at, paid_at, price_cents, tier)
         VALUES ($1,$2,$3,$4,$5,$6,'player',$7,$8,$9,$10,$11)`,
        [m2, ids[name], name, normalizeName(name), method, status,
          crypto.randomBytes(12).toString('hex'), at, status === 'paid' ? at : null,
          priceOf(name), tierOf(name)]
      );
    }
    await setSetting(client, 'demo_seeded', '1');
    await setSetting(client, 'demo_reseed', '0');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    client.release();
    throw e;
  }
  client.release();
  return true;
}

/* =========================================================
   Paramètres
   ========================================================= */

async function getSetting(pool, key, fallback = null) {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  return rows.length ? rows[0].value : fallback;
}

async function setSetting(pool, key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

module.exports = {
  openDatabase,
  getPool,
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
