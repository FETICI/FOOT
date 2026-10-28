'use strict';
const crypto = require('node:crypto');
const {
  normalizeName, getSetting, createPlayer, ensureMatchLinks, currentSeasonId, seasonFor,
} = require('./db');
const { normalizePhone, formatPhone } = require('./phone');
const { today, addDays, nextFriday, isValidDate, isValidTime } = require('./dates');
const {
  standing, priceFor, linkActive, phaseRequiresPriority, SUBSCRIPTIONS, SUBSCRIPTION_LABEL, TIER_LABEL, LINK_LEVELS, LOYALTY_THRESHOLD,
} = require('./pricing');

const STATUSES = ['draft', 'priority', 'open', 'invite', 'closed'];
const METHODS = ['card', 'cash'];
const PAY_STATUSES = ['to_pay', 'paid', 'cash_due'];
const ATTENDANCES = ['unknown', 'present', 'absent'];
const PAYMENT_LINK_AMOUNTS = [500, 1000];

class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function cleanFirstName(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new AppError(400, 'name_required', 'Indique ton prénom.');
  if (s.length > 30) throw new AppError(400, 'name_too_long', 'Prénom trop long (30 caractères max).');
  if (!/\p{L}/u.test(s)) throw new AppError(400, 'name_invalid', 'Ce prénom ne semble pas valide.');
  return s.replace(/(^|[\s-])(\p{Ll})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

function defaultStatusFor(method) {
  return method === 'cash' ? 'cash_due' : 'to_pay';
}

function nameForm(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function namesMatch(typed, stored) {
  const a = nameForm(typed);
  return a !== '' && a === nameForm(stored);
}

function requirePhone(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new AppError(400, 'phone_required', 'Indique ton numéro de téléphone.');
  }
  const n = normalizePhone(raw);
  if (!n) throw new AppError(400, 'phone_invalid', 'Numéro de téléphone invalide. Exemple : 06 12 34 56 78');
  return n;
}

const MSG = {
  invalid_link: `Ce lien d'inscription n'est pas valide.`,
  not_open: 'Les inscriptions ne sont pas encore ouvertes pour ce lien.',
  closed: 'Les inscriptions sont fermées.',
  finished: 'Ce match est terminé.',
  priority_only: `Les inscriptions sont actuellement réservées aux joueurs prioritaires. Tu pourras revenir lorsque les inscriptions seront ouvertes à tous.`,
  phone_name_mismatch: `Ce numéro est déjà associé à un joueur. Vérifie ton prénom ou contacte l'organisateur.`,
  already_registered: 'Tu es déjà inscrit à ce foot ✅',
  full: 'Toutes les places sont prises.',
};

function createRepo(pool) {
  /* ---------- Helpers requêtes ---------- */

  async function q(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows;
  }
  async function q1(sql, params = []) {
    const rows = await q(sql, params);
    return rows[0] || null;
  }

  async function matchById(id) { return q1(`SELECT * FROM matches WHERE id = $1`, [id]); }
  async function regById(id) { return q1(`SELECT * FROM registrations WHERE id = $1`, [id]); }
  async function regsByMatch(matchId) {
    return q(`SELECT r.*, p.first_name AS player_name FROM registrations r LEFT JOIN players p ON p.id = r.player_id WHERE r.match_id = $1 ORDER BY r.created_at, r.id`, [matchId]);
  }
  async function countByMatch(matchId) { return parseInt((await q1(`SELECT COUNT(*) AS n FROM registrations WHERE match_id = $1`, [matchId])).n); }
  async function regByPlayerMatch(matchId, playerId) { return q1(`SELECT * FROM registrations WHERE match_id = $1 AND player_id = $2`, [matchId, playerId]); }
  async function playerById(id) { return q1(`SELECT * FROM players WHERE id = $1`, [id]); }
  async function playersByKey(key) { return q(`SELECT * FROM players WHERE name_key = $1 ORDER BY id`, [key]); }
  async function playerSeason(playerId, seasonId) { return q1(`SELECT * FROM player_seasons WHERE player_id = $1 AND season_id = $2`, [playerId, seasonId]); }
  async function presentCount(playerId, seasonId) {
    return parseInt((await q1(`SELECT COUNT(*) AS n FROM registrations r JOIN matches m ON m.id = r.match_id WHERE r.player_id = $1 AND m.season_id = $2 AND r.attendance = 'present'`, [playerId, seasonId])).n);
  }
  async function playerByPhone(phone) { return q1(`SELECT * FROM players WHERE phone_normalized = $1`, [phone]); }
  async function legacyHomonyms(key, excludeId) { return q(`SELECT id, first_name FROM players WHERE name_key = $1 AND phone_normalized IS NULL AND id <> $2`, [key, excludeId]); }
  async function seasonById(id) { return q1(`SELECT * FROM seasons WHERE id = $1`, [id]); }
  async function linksByMatch(matchId) { return q(`SELECT level, token FROM match_links WHERE match_id = $1`, [matchId]); }
  async function linkByToken(token) { return q1(`SELECT * FROM match_links WHERE token = $1`, [token]); }

  const seasonId = () => currentSeasonId(pool);

  /* ---------- Saison / statut d'un joueur ---------- */

  async function ensurePlayerSeason(playerId, sid) {
    await pool.query(`INSERT INTO player_seasons (player_id, season_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [playerId, sid]);
    return playerSeason(playerId, sid);
  }

  async function participations(playerId, sid) {
    const ps = await playerSeason(playerId, sid);
    const n = await presentCount(playerId, sid);
    return Math.max(0, n + (ps ? ps.participations_adjustment : 0));
  }

  async function standingOf(playerId, sid) {
    const ps = await playerSeason(playerId, sid);
    return standing(ps ? ps.subscription : 'none', await participations(playerId, sid));
  }

  /* ---------- Vues ---------- */

  async function linksOf(match) {
    const links = await linksByMatch(match.id);
    const map = Object.fromEntries(links.map((l) => [l.level, l.token]));
    return LINK_LEVELS.map((level) => ({ level, token: map[level], active: linkActive(match.status, level) }));
  }

  async function paymentLinkFor(priceCents) {
    if (!PAYMENT_LINK_AMOUNTS.includes(priceCents)) return '';
    return ((await getSetting(pool, `payment_link_${priceCents}`, '')) || '').trim();
  }

  async function missingCardLinks(match) {
    const amounts = [...new Set([match.subscriber_price_cents, match.price_cents])].filter((c) => c > 0);
    const missing = [];
    for (const c of amounts) {
      if (!await paymentLinkFor(c)) missing.push(c);
    }
    return missing;
  }

  function statsFor(match, regs) {
    const registered = regs.length;
    const count = (f) => regs.filter(f).length;
    const sum = (f) => regs.filter(f).reduce((a, r) => a + (r.price_cents || 0), 0);
    return {
      registered,
      remaining: Math.max(0, match.capacity - registered),
      paid: count((r) => r.payment_status === 'paid'),
      cash_due: count((r) => r.payment_status === 'cash_due'),
      to_pay: count((r) => r.payment_status === 'to_pay'),
      unpaid: count((r) => r.payment_status !== 'paid'),
      card: count((r) => r.payment_method === 'card'),
      cash: count((r) => r.payment_method === 'cash'),
      subscribers: count((r) => r.tier !== 'standard'),
      present: count((r) => r.attendance === 'present'),
      absent: count((r) => r.attendance === 'absent'),
      revenue_collected_cents: sum((r) => r.payment_status === 'paid'),
      revenue_expected_cents: sum(() => true),
    };
  }

  async function adminMatchView(match) {
    const regs = await regsByMatch(match.id);
    const season = match.season_id ? await seasonById(match.season_id) : null;
    return {
      match: {
        ...match,
        is_past: match.date < today(),
        missing_card_links: await missingCardLinks(match),
        season_name: season ? season.name : null,
      },
      links: await linksOf(match),
      registrations: regs.map((r) => ({
        id: r.id,
        player_id: r.player_id,
        first_name: r.player_name || r.first_name,
        payment_method: r.payment_method,
        payment_status: r.payment_status,
        price_cents: r.price_cents,
        tier: r.tier,
        tier_label: TIER_LABEL[r.tier],
        attendance: r.attendance,
        source: r.source,
        created_at: r.created_at,
        paid_at: r.paid_at,
      })),
      stats: statsFor(match, regs),
    };
  }

  function publicMatchView_sync(match, regs) {
    return {
      match: {
        id: match.id,
        date: match.date,
        time: match.time,
        location: match.location,
        price_cents: match.price_cents,
        subscriber_price_cents: match.subscriber_price_cents,
        capacity: match.capacity,
        status: match.status,
      },
      registered: regs.length,
      remaining: Math.max(0, match.capacity - regs.length),
      players: regs.map((r) => r.player_name || r.first_name),
    };
  }

  async function publicMatchView(match) {
    const regs = await regsByMatch(match.id);
    return publicMatchView_sync(match, regs);
  }

  async function ownRegistration(player, match) {
    const reg = await regByPlayerMatch(match.id, player.id);
    if (!reg) return null;
    return {
      first_name: player.first_name,
      payment_method: reg.payment_method,
      price_cents: reg.price_cents,
      tier: reg.tier,
      subscriber: reg.tier !== 'standard',
      loyalty_upgrade: reg.tier === 'loyalty_upgrade',
      payment_link: reg.payment_method === 'card' ? await paymentLinkFor(reg.price_cents) : '',
    };
  }

  async function requireMatch(id) {
    const m = await matchById(Number(id));
    if (!m) throw new AppError(404, 'not_found', 'Match introuvable.');
    return m;
  }

  async function requireReg(id) {
    const r = await regById(Number(id));
    if (!r) throw new AppError(404, 'not_found', 'Inscription introuvable.');
    return r;
  }

  async function requirePlayer(id) {
    const p = await playerById(Number(id));
    if (!p) throw new AppError(404, 'not_found', 'Joueur introuvable.');
    return p;
  }

  function linkState(match, link) {
    if (!match || !link || link.match_id !== match.id) return 'invalid';
    if (match.date < today()) return 'finished';
    if (match.status === 'closed') return 'closed';
    if (!linkActive(match.status, link.level)) return 'not_open';
    return 'open';
  }

  /* ---------- Validation match ---------- */

  function parseMatchInput(input, { partial = false } = {}) {
    const out = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
    const need = (k) => !partial || has(k);
    const cents = (k, label) => {
      const p = Number(input[k]);
      if (!Number.isInteger(p) || p < 0 || p > 100000) throw new AppError(400, 'invalid_price', `${label} invalide.`);
      return p;
    };
    if (need('date')) {
      if (!isValidDate(input.date)) throw new AppError(400, 'invalid_date', 'Date invalide.');
      out.date = input.date;
    }
    if (need('time')) {
      if (!isValidTime(input.time)) throw new AppError(400, 'invalid_time', `Heure invalide (format HH:MM).`);
      out.time = input.time;
    }
    if (need('location')) {
      const loc = String(input.location ?? '').trim();
      if (!loc || loc.length > 120) throw new AppError(400, 'invalid_location', 'Indique un lieu (120 caractères max).');
      out.location = loc;
    }
    if (need('price_cents')) out.price_cents = cents('price_cents', 'Prix');
    if (has('subscriber_price_cents')) out.subscriber_price_cents = cents('subscriber_price_cents', `Prix abonné`);
    else if (!partial) out.subscriber_price_cents = 500;
    if (need('capacity')) {
      const c = Number(input.capacity);
      if (!Number.isInteger(c) || c < 1 || c > 200) throw new AppError(400, 'invalid_capacity', 'Nombre de places invalide (1 à 200).');
      out.capacity = c;
    }
    if (has('status') || !partial) {
      const s = input.status ?? 'priority';
      if (!STATUSES.includes(s)) throw new AppError(400, 'invalid_status', 'Statut invalide.');
      out.status = s;
    }
    if (has('payment_link') || !partial) {
      const l = String(input.payment_link ?? '').trim();
      if (l && !/^https?:\/\/\S+$/i.test(l)) throw new AppError(400, 'invalid_link', 'Le lien de paiement doit commencer par https://');
      if (l.length > 500) throw new AppError(400, 'invalid_link', 'Lien de paiement trop long.');
      out.payment_link = l;
    }
    return out;
  }

  /* ---------- Inscription ---------- */

  async function insertRegistration(client, match, playerId, { method, status, pricing, source }) {
    // client = pg PoolClient (dans une transaction)
    const { rows: pr } = await client.query(`SELECT * FROM players WHERE id = $1`, [playerId]);
    const p = pr[0];
    const { rows } = await client.query(
      `INSERT INTO registrations (match_id, player_id, first_name, name_key, payment_method, payment_status, source, token, paid_at, price_cents, tier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [match.id, playerId, p.first_name, p.name_key, method, status, source,
        crypto.randomBytes(16).toString('hex'),
        status === 'paid' ? new Date().toISOString() : null,
        pricing.price_cents, pricing.tier]
    );
    if (pricing.upgrade) {
      await client.query(
        `UPDATE player_seasons SET subscription = 'loyalty', subscribed_at = $1 WHERE player_id = $2 AND season_id = $3 AND subscription = 'none'`,
        [new Date().toISOString(), playerId, match.season_id]
      );
    }
    return regById(rows[0].id);
  }

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    AppError,
    MSG,

    async currentAdminMatch() {
      const m = await q1(`SELECT * FROM matches WHERE date >= $1 ORDER BY date, time, id LIMIT 1`, [today()]);
      return m ? adminMatchView(m) : null;
    },

    async currentPublicMatch() {
      const m = await q1(`SELECT * FROM matches WHERE date >= $1 AND status <> 'draft' ORDER BY date, time, id LIMIT 1`, [today()]);
      return { current: m ? await publicMatchView(m) : null };
    },

    async publicMatch(id) {
      const m = await matchById(Number(id));
      if (!m || m.status === 'draft') throw new AppError(404, 'not_found', 'Match introuvable.');
      return { current: await publicMatchView(m) };
    },

    async publicLink(token) {
      const link = typeof token === 'string' && token.length >= 20 && token.length <= 100 ? await linkByToken(token) : null;
      const match = link ? await matchById(link.match_id) : null;
      const state = linkState(match, link);
      if (state === 'invalid') return { state, message: MSG.invalid_link };
      const view = await publicMatchView(match);
      return {
        state,
        message: state === 'open' ? null : MSG[state],
        priority_only: state === 'open' && phaseRequiresPriority(match.status),
        current: view,
      };
    },

    async registerPublic(matchId, input) {
      const match = await matchById(Number(matchId));
      const link = typeof input.link_token === 'string' && input.link_token.length <= 100 ? await linkByToken(input.link_token) : null;
      const state = linkState(match, link);
      if (state === 'invalid') throw new AppError(404, 'invalid_link', MSG.invalid_link);
      if (state !== 'open') throw new AppError(403, state, MSG[state]);

      const name = cleanFirstName(input.first_name);
      const phone = requirePhone(input.phone);
      const method = input.payment_method;
      if (!METHODS.includes(method)) throw new AppError(400, 'method_required', 'Choisis ton mode de paiement.');

      return tx(async (client) => {
        const cq = (sql, params) => client.query(sql, params).then(r => r.rows);
        const cq1 = async (sql, params) => (await cq(sql, params))[0] || null;

        const player = await cq1(`SELECT * FROM players WHERE phone_normalized = $1`, [phone]);
        if (player && !namesMatch(name, player.first_name)) {
          throw new AppError(409, 'phone_name_mismatch', MSG.phone_name_mismatch);
        }
        if (player) {
          const existing = await cq1(`SELECT * FROM registrations WHERE match_id = $1 AND player_id = $2`, [match.id, player.id]);
          if (existing) {
            throw new AppError(409, 'already_registered', MSG.already_registered, { registration: await ownRegistration(player, match) });
          }
        }
        const st = player ? await standingOf(player.id, match.season_id) : standing('none', 0);
        if (phaseRequiresPriority(match.status) && !st.priority) {
          throw new AppError(403, 'priority_only', MSG.priority_only);
        }
        const cnt = parseInt((await cq1(`SELECT COUNT(*) AS n FROM registrations WHERE match_id = $1`, [match.id])).n);
        if (cnt >= match.capacity) throw new AppError(409, 'full', MSG.full);

        let playerId = player ? player.id : null;
        if (!playerId) {
          const legacy = await legacyHomonyms(normalizeName(name), -1);
          playerId = await createPlayer(client, { first_name: name, season_id: match.season_id, phone, needs_review: legacy.length > 0 });
        }
        const pricing = priceFor(st, match);
        await insertRegistration(client, match, playerId, { method, status: defaultStatusFor(method), pricing, source: 'player' });
        const p = await playerById(playerId);
        return {
          created_player: !player,
          registration: await ownRegistration(p, match),
          payment_link: method === 'card' ? await paymentLinkFor(pricing.price_cents) : '',
          current: await publicMatchView(match),
        };
      });
    },

    async lookupPublic(matchId, input) {
      const match = await matchById(Number(matchId));
      const link = typeof input.link_token === 'string' && input.link_token.length <= 100 ? await linkByToken(input.link_token) : null;
      if (linkState(match, link) === 'invalid') throw new AppError(404, 'invalid_link', MSG.invalid_link);
      const phone = normalizePhone(input.phone);
      const player = phone ? await playerByPhone(phone) : null;
      if (!player || !namesMatch(String(input.first_name ?? ''), player.first_name)) return { registration: null };
      return { registration: await ownRegistration(player, match) };
    },

    async registerAdmin(matchId, input) {
      const match = await requireMatch(matchId);
      const method = input.payment_method;
      if (!METHODS.includes(method)) throw new AppError(400, 'method_required', 'Choisis le mode de paiement.');
      let status = defaultStatusFor(method);
      if (input.payment_status !== undefined) {
        if (!PAY_STATUSES.includes(input.payment_status)) throw new AppError(400, 'invalid_payment_status', 'Statut de paiement invalide.');
        status = input.payment_status === 'paid' ? 'paid' : defaultStatusFor(method);
      }
      let existingPlayer = input.player_id ? await requirePlayer(input.player_id) : null;
      const newName = existingPlayer ? null : cleanFirstName(input.first_name);
      const phone = !existingPlayer && input.phone ? requirePhone(input.phone) : null;
      if (phone) {
        const owner = await playerByPhone(phone);
        if (owner && !namesMatch(newName, owner.first_name)) {
          throw new AppError(409, 'phone_taken', `Ce numéro appartient déjà à la fiche « ${owner.first_name} ». Choisis cette fiche dans la liste.`);
        }
        if (owner) existingPlayer = owner;
      }
      return tx(async (client) => {
        if (existingPlayer) {
          const existing = await regByPlayerMatch(match.id, existingPlayer.id);
          if (existing) throw new AppError(409, 'already_registered', `${existingPlayer.first_name} est déjà inscrit à ce match.`);
        }
        const cnt = await countByMatch(match.id);
        if (cnt >= match.capacity) throw new AppError(409, 'full', MSG.full);
        const playerId = existingPlayer ? existingPlayer.id : await createPlayer(client, { first_name: newName, season_id: match.season_id, phone });
        const pricing = priceFor(await standingOf(playerId, match.season_id), match);
        await insertRegistration(client, match, playerId, { method, status, pricing, source: 'admin' });
        return adminMatchView(match);
      });
    },

    async adminMatch(id) {
      return adminMatchView(await requireMatch(id));
    },

    async listMatches() {
      const t = today();
      const rows = await q(`
        SELECT m.*, s.name AS season_name,
               (SELECT COUNT(*) FROM registrations r WHERE r.match_id = m.id) AS registered,
               (SELECT COUNT(*) FROM registrations r WHERE r.match_id = m.id AND r.payment_status = 'paid') AS paid,
               (SELECT COALESCE(SUM(price_cents),0) FROM registrations r WHERE r.match_id = m.id AND r.payment_status = 'paid') AS revenue_collected_cents,
               (SELECT COALESCE(SUM(price_cents),0) FROM registrations r WHERE r.match_id = m.id) AS revenue_expected_cents,
               (SELECT COUNT(*) FROM registrations r WHERE r.match_id = m.id AND r.attendance = 'present') AS present
        FROM matches m LEFT JOIN seasons s ON s.id = m.season_id
        ORDER BY m.date DESC, m.id DESC`);
      return rows.map((m) => ({
        ...m,
        registered: parseInt(m.registered),
        paid: parseInt(m.paid),
        is_past: m.date < t,
        unpaid: parseInt(m.registered) - parseInt(m.paid),
      }));
    },

    async nextDefaults() {
      const last = await q1(`SELECT * FROM matches ORDER BY date DESC, id DESC LIMIT 1`);
      const base = nextFriday();
      let date = base;
      if (last && last.date >= base) date = addDays(last.date, 7);
      return {
        date,
        time: last?.time ?? '20:00',
        location: last?.location ?? 'UrbanSoccer Nice',
        price_cents: last?.price_cents ?? 1000,
        subscriber_price_cents: last?.subscriber_price_cents ?? 500,
        capacity: last?.capacity ?? 14,
        status: 'priority',
      };
    },

    async createMatch(input) {
      const m = parseMatchInput(input);
      const sid = await seasonId();
      const { rows } = await pool.query(
        `INSERT INTO matches (date, time, location, price_cents, subscriber_price_cents, capacity, status, payment_link, season_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [m.date, m.time, m.location, m.price_cents, m.subscriber_price_cents, m.capacity, m.status, m.payment_link, sid]
      );
      await ensureMatchLinks(pool, rows[0].id);
      return adminMatchView(await requireMatch(rows[0].id));
    },

    async updateMatch(id, input) {
      await requireMatch(id);
      const m = parseMatchInput(input, { partial: true });
      const keys = Object.keys(m);
      if (keys.length) {
        const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        await pool.query(`UPDATE matches SET ${sets} WHERE id = $${keys.length + 1}`, [...keys.map((k) => m[k]), Number(id)]);
      }
      return adminMatchView(await requireMatch(id));
    },

    async deleteMatch(id) {
      await requireMatch(id);
      await pool.query(`DELETE FROM matches WHERE id = $1`, [Number(id)]);
    },

    async regenerateLinks(id) {
      const m = await requireMatch(id);
      await tx(async (client) => {
        await client.query(`DELETE FROM match_links WHERE match_id = $1`, [m.id]);
        await ensureMatchLinks(client, m.id);
      });
      return adminMatchView(m);
    },

    async updateRegistration(id, input) {
      const reg = await requireReg(id);
      const patch = {};
      const method = input.payment_method !== undefined ? input.payment_method : reg.payment_method;
      if (!METHODS.includes(method)) throw new AppError(400, 'invalid_method', 'Mode de paiement invalide.');
      if (input.payment_method !== undefined) patch.payment_method = method;

      if (input.payment_status !== undefined) {
        if (!PAY_STATUSES.includes(input.payment_status)) throw new AppError(400, 'invalid_payment_status', 'Statut de paiement invalide.');
        patch.payment_status = input.payment_status === 'paid' ? 'paid' : defaultStatusFor(method);
      } else if (input.payment_method !== undefined && reg.payment_status !== 'paid') {
        patch.payment_status = defaultStatusFor(method);
      }
      if (patch.payment_status) patch.paid_at = patch.payment_status === 'paid' ? (reg.paid_at || new Date().toISOString()) : null;

      if (input.price_cents !== undefined) {
        const p = Number(input.price_cents);
        if (!Number.isInteger(p) || p < 0 || p > 100000) throw new AppError(400, 'invalid_price', 'Tarif invalide.');
        patch.price_cents = p;
      }
      if (input.attendance !== undefined) {
        if (!ATTENDANCES.includes(input.attendance)) throw new AppError(400, 'invalid_attendance', `Présence invalide.`);
        patch.attendance = input.attendance;
        patch.attendance_at = input.attendance === 'unknown' ? null : new Date().toISOString();
      }
      const keys = Object.keys(patch);
      if (keys.length) {
        const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        await pool.query(`UPDATE registrations SET ${sets} WHERE id = $${keys.length + 1}`, [...keys.map((k) => patch[k]), reg.id]);
      }
      return adminMatchView(await requireMatch(reg.match_id));
    },

    async deleteRegistration(id) {
      const reg = await requireReg(id);
      await pool.query(`DELETE FROM registrations WHERE id = $1`, [reg.id]);
      return adminMatchView(await requireMatch(reg.match_id));
    },

    async listPlayers() {
      const sid = await seasonId();
      const next = await this.nextDefaults();
      const rows = await q(`
        SELECT p.*, COALESCE(ps.subscription, 'none') AS subscription, COALESCE(ps.participations_adjustment, 0) AS adjustment,
               (SELECT COUNT(*) FROM registrations r JOIN matches m ON m.id = r.match_id
                 WHERE r.player_id = p.id AND m.season_id = $1 AND r.attendance = 'present') AS present_season,
               (SELECT COUNT(*) FROM registrations r WHERE r.player_id = p.id) AS registrations_total,
               (SELECT MAX(m.date) FROM registrations r JOIN matches m ON m.id = r.match_id WHERE r.player_id = p.id) AS last_match
        FROM players p LEFT JOIN player_seasons ps ON ps.player_id = p.id AND ps.season_id = $2
        ORDER BY p.first_name, p.id`, [sid, sid]);
      return rows.map((r) => {
        const st = standing(r.subscription, Math.max(0, parseInt(r.present_season) + parseInt(r.adjustment)));
        const price = priceFor(st, next);
        return {
          id: r.id,
          first_name: r.first_name,
          phone: r.phone_normalized,
          phone_display: formatPhone(r.phone_normalized),
          missing_phone: !r.phone_normalized,
          needs_review: !!r.needs_review,
          is_demo: !!r.is_demo,
          ...st,
          price_cents: price.price_cents,
          registrations_total: parseInt(r.registrations_total),
          last_match: r.last_match,
          homonyms: rows.filter((o) => o.name_key === r.name_key).length > 1,
        };
      });
    },

    async createPlayerAdmin(input) {
      const name = cleanFirstName(input.first_name);
      const sub = input.subscription ?? 'none';
      if (!SUBSCRIPTIONS.includes(sub)) throw new AppError(400, 'invalid_subscription', 'Statut invalide.');
      const phone = input.phone ? requirePhone(input.phone) : null;
      const id = await tx(async (client) => {
        if (phone) {
          const owner = await playerByPhone(phone);
          if (owner) throw new AppError(409, 'phone_taken', `Ce numéro est déjà utilisé par la fiche « ${owner.first_name} ».`, { other_player_id: owner.id });
        }
        return createPlayer(client, { first_name: name, season_id: await seasonId(), subscription: sub, phone });
      });
      return this.playerDetail(id);
    },

    async playerDetail(id) {
      const p = await requirePlayer(id);
      const sid = await seasonId();
      await ensurePlayerSeason(p.id, sid);
      const st = await standingOf(p.id, sid);
      const history = await q(`
        SELECT r.id, r.match_id, r.price_cents, r.tier, r.attendance, r.payment_status, r.payment_method,
               m.date, m.time, m.location, m.season_id, s.name AS season_name
        FROM registrations r JOIN matches m ON m.id = r.match_id LEFT JOIN seasons s ON s.id = m.season_id
        WHERE r.player_id = $1 ORDER BY m.date DESC, m.id DESC`, [p.id]);
      const seasonRows = await q(`
        SELECT s.id, s.name, s.is_current, ps.subscription, ps.participations_adjustment
        FROM player_seasons ps JOIN seasons s ON s.id = ps.season_id
        WHERE ps.player_id = $1 ORDER BY s.id DESC`, [p.id]);
      const seasons = await Promise.all(seasonRows.map(async (s) => ({
        ...s,
        label: SUBSCRIPTION_LABEL[s.subscription],
        participations: await participations(p.id, s.id),
      })));
      const allByKey = await playersByKey(p.name_key);
      const homonyms = allByKey.filter((o) => o.id !== p.id)
        .map((o) => ({ id: o.id, first_name: o.first_name, phone_display: formatPhone(o.phone_normalized), missing_phone: !o.phone_normalized }));
      const next = await this.nextDefaults();
      const ps = await playerSeason(p.id, sid);
      return {
        player: {
          id: p.id,
          first_name: p.first_name,
          phone: p.phone_normalized,
          phone_display: formatPhone(p.phone_normalized),
          missing_phone: !p.phone_normalized,
          needs_review: !!p.needs_review,
          created_at: p.created_at,
          is_demo: !!p.is_demo,
          ...st,
          price_cents: priceFor(st, next).price_cents,
          present_season: await presentCount(p.id, sid),
          adjustment: ps ? ps.participations_adjustment : 0,
        },
        stats: {
          matches: history.length,
          present: history.filter((h) => h.attendance === 'present').length,
          absent: history.filter((h) => h.attendance === 'absent').length,
          unknown: history.filter((h) => h.attendance === 'unknown').length,
          billed_cents: history.reduce((a, h) => a + (h.price_cents || 0), 0),
          paid_cents: history.filter((h) => h.payment_status === 'paid').reduce((a, h) => a + (h.price_cents || 0), 0),
        },
        history: history.map((h) => ({ ...h, tier_label: TIER_LABEL[h.tier], is_past: h.date < today() })),
        seasons,
        homonyms,
        season_id: sid,
      };
    },

    async updatePlayer(id, input) {
      const p = await requirePlayer(id);
      const sid = await seasonId();
      await tx(async (client) => {
        await client.query(`INSERT INTO player_seasons (player_id, season_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [p.id, sid]);
        if (input.first_name !== undefined) {
          const name = cleanFirstName(input.first_name);
          const key = normalizeName(name);
          await client.query(`UPDATE players SET first_name = $1, name_key = $2 WHERE id = $3`, [name, key, p.id]);
        }
        if (input.phone !== undefined) {
          const phone = String(input.phone).trim() === '' ? null : requirePhone(input.phone);
          if (phone) {
            const { rows } = await client.query(`SELECT * FROM players WHERE phone_normalized = $1`, [phone]);
            const owner = rows[0];
            if (owner && owner.id !== p.id) {
              throw new AppError(409, 'phone_taken',
                `Ce numéro est déjà utilisé par la fiche « ${owner.first_name} ». S'il s'agit de la même personne, utilise « Fusionner ».`,
                { other_player_id: owner.id });
            }
          }
          await client.query(`UPDATE players SET phone_normalized = $1 WHERE id = $2`, [phone, p.id]);
        }
        if (input.needs_review === false) {
          await client.query(`UPDATE players SET needs_review = 0 WHERE id = $1`, [p.id]);
        }
        if (input.subscription !== undefined) {
          if (!SUBSCRIPTIONS.includes(input.subscription)) throw new AppError(400, 'invalid_subscription', 'Statut invalide.');
          await client.query(`UPDATE player_seasons SET subscription = $1, subscribed_at = $2 WHERE player_id = $3 AND season_id = $4`,
            [input.subscription, input.subscription === 'none' ? null : new Date().toISOString(), p.id, sid]);
        }
        if (input.participations !== undefined) {
          const target = Number(input.participations);
          if (!Number.isInteger(target) || target < 0 || target > 500) throw new AppError(400, 'invalid_participations', 'Nombre de participations invalide.');
          const cnt = await presentCount(p.id, sid);
          await client.query(`UPDATE player_seasons SET participations_adjustment = $1 WHERE player_id = $2 AND season_id = $3`, [target - cnt, p.id, sid]);
        }
      });
      return this.playerDetail(p.id);
    },

    async mergePlayers(sourceId, targetId, { phoneFrom = 'target' } = {}) {
      const src = await requirePlayer(sourceId);
      const dst = await requirePlayer(targetId);
      if (src.id === dst.id) throw new AppError(400, 'same_player', 'Choisis deux fiches différentes.');
      const conflicts = await q(`
        SELECT m.date FROM registrations a JOIN registrations b ON a.match_id = b.match_id JOIN matches m ON m.id = a.match_id
        WHERE a.player_id = $1 AND b.player_id = $2`, [src.id, dst.id]);
      if (conflicts.length) {
        throw new AppError(409, 'merge_conflict',
          `Les deux fiches sont inscrites au même match (${conflicts.map((c) => c.date).join(', ')}). Supprime d'abord l'une des deux inscriptions.`);
      }
      const rank = { none: 0, loyalty: 1, annual: 2 };
      await tx(async (client) => {
        const keepPhone = phoneFrom === 'source'
          ? (src.phone_normalized || dst.phone_normalized)
          : (dst.phone_normalized || src.phone_normalized);
        await client.query(`UPDATE registrations SET player_id = $1 WHERE player_id = $2`, [dst.id, src.id]);
        const { rows: srcSeasons } = await client.query(`SELECT * FROM player_seasons WHERE player_id = $1`, [src.id]);
        for (const s of srcSeasons) {
          const { rows: dRows } = await client.query(`SELECT * FROM player_seasons WHERE player_id = $1 AND season_id = $2`, [dst.id, s.season_id]);
          const d = dRows[0];
          if (!d) {
            await client.query(`UPDATE player_seasons SET player_id = $1 WHERE player_id = $2 AND season_id = $3`, [dst.id, src.id, s.season_id]);
          } else {
            const best = rank[s.subscription] > rank[d.subscription] ? s : d;
            await client.query(`UPDATE player_seasons SET subscription = $1, subscribed_at = $2, participations_adjustment = $3 WHERE player_id = $4 AND season_id = $5`,
              [best.subscription, best.subscribed_at, d.participations_adjustment + s.participations_adjustment, dst.id, s.season_id]);
          }
        }
        await client.query(`DELETE FROM players WHERE id = $1`, [src.id]);
        await client.query(`UPDATE players SET phone_normalized = $1, needs_review = 0 WHERE id = $2`, [keepPhone, dst.id]);
      });
      return this.playerDetail(dst.id);
    },

    async deletePlayer(id) {
      const p = await requirePlayer(id);
      const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM registrations WHERE player_id = $1`, [p.id]);
      if (parseInt(rows[0].n)) throw new AppError(409, 'has_registrations', `Ce joueur a un historique de matchs : fusionne-le plutôt avec la bonne fiche.`);
      await pool.query(`DELETE FROM players WHERE id = $1`, [p.id]);
    },

    async listSeasons() {
      return q(`
        SELECT s.*,
          (SELECT COUNT(*) FROM matches m WHERE m.season_id = s.id) AS matches,
          (SELECT COUNT(*) FROM player_seasons ps WHERE ps.season_id = s.id AND ps.subscription <> 'none') AS subscribers
        FROM seasons s ORDER BY s.id DESC`);
    },

    async startSeason(input) {
      const name = String(input.name ?? '').trim() || seasonFor(today()).name;
      if (name.length > 40) throw new AppError(400, 'invalid_name', 'Nom de saison trop long.');
      const start = isValidDate(input.start_date) ? input.start_date : today();
      const prev = await seasonId();
      return tx(async (client) => {
        await client.query(`UPDATE seasons SET is_current = 0`);
        const { rows } = await client.query(`INSERT INTO seasons (name, start_date, is_current) VALUES ($1,$2,1) RETURNING id`, [name, start]);
        const sid = rows[0].id;
        if (input.carry_annual === true && prev) {
          await client.query(`INSERT INTO player_seasons (player_id, season_id, subscription, subscribed_at)
                              SELECT player_id, $1, 'annual', $2 FROM player_seasons WHERE season_id = $3 AND subscription = 'annual'
                              ON CONFLICT DO NOTHING`,
            [sid, new Date().toISOString(), prev]);
        }
        await client.query(`UPDATE matches SET season_id = $1 WHERE date >= $2`, [sid, start]);
        return this.listSeasons();
      });
    },

    async currentSeason() {
      return q1(`SELECT * FROM seasons WHERE is_current = 1 ORDER BY id DESC LIMIT 1`);
    },

    async clearDemo() {
      return tx(async (client) => {
        const { rowCount } = await client.query(`DELETE FROM matches WHERE is_demo = 1`);
        await client.query(`DELETE FROM players WHERE is_demo = 1 AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.player_id = players.id)`);
        return rowCount;
      });
    },

    async hasDemo() {
      const r = await q1(`SELECT 1 AS x FROM matches WHERE is_demo = 1 UNION SELECT 1 FROM players WHERE is_demo = 1 LIMIT 1`);
      return !!r;
    },

    LOYALTY_THRESHOLD,
    paymentLinkFor,
  };
}

module.exports = { createRepo, AppError, cleanFirstName, PAYMENT_LINK_AMOUNTS, namesMatch };
