'use strict';
const crypto = require('node:crypto');
const {
  normalizeName, getSetting, createPlayer, ensureMatchLinks, currentSeasonId, newPlayerCode, seasonFor,
} = require('./db');
const { today, addDays, nextFriday, isValidDate, isValidTime } = require('./dates');
const {
  standing, priceFor, linkActive, phaseRequiresPriority, SUBSCRIPTIONS, SUBSCRIPTION_LABEL, TIER_LABEL, LINK_LEVELS, LOYALTY_THRESHOLD,
} = require('./pricing');

const STATUSES = ['draft', 'priority', 'open', 'invite', 'closed'];
const METHODS = ['card', 'cash'];
const PAY_STATUSES = ['to_pay', 'paid', 'cash_due'];
const ATTENDANCES = ['unknown', 'present', 'absent'];
/** Montants (centimes) pour lesquels l'organisateur renseigne un lien bancaire réutilisable. */
const PAYMENT_LINK_AMOUNTS = [500, 1000];

class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Met en forme un prénom saisi : espaces normalisés, initiale en majuscule. */
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

const hashDevice = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/* Messages destinés aux joueurs (jamais de détail technique) */
const MSG = {
  invalid_link: 'Ce lien d’inscription n’est pas valide.',
  not_open: 'Les inscriptions ne sont pas encore ouvertes pour ce lien.',
  closed: 'Les inscriptions sont fermées.',
  finished: 'Ce match est terminé.',
  priority_only: 'Les inscriptions sont actuellement réservées aux joueurs prioritaires. Tu pourras revenir lorsque les inscriptions seront ouvertes à tous.',
  subscriber_not_recognized: 'Ton statut abonné n’a pas été reconnu. Tu peux t’inscrire au tarif normal ou contacter l’organisateur.',
  code_required: 'Entre ton code joueur pour être reconnu comme abonné.',
  name_taken: 'Un joueur portant ce prénom est déjà enregistré. Si c’est toi, entre ton code joueur. Sinon, ajoute l’initiale de ton nom (ex. Thomas B.).',
  already_registered: 'Tu es déjà inscrit à ce match ✅',
  full: 'Toutes les places sont prises.',
};

function createRepo(db) {
  const q = {
    matchById: db.prepare('SELECT * FROM matches WHERE id = ?'),
    regById: db.prepare('SELECT * FROM registrations WHERE id = ?'),
    regsByMatch: db.prepare(`
      SELECT r.*, p.first_name AS player_name, p.code AS player_code
      FROM registrations r LEFT JOIN players p ON p.id = r.player_id
      WHERE r.match_id = ? ORDER BY r.created_at, r.id`),
    countByMatch: db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE match_id = ?'),
    regByPlayerMatch: db.prepare('SELECT * FROM registrations WHERE match_id = ? AND player_id = ?'),
    upcomingAny: db.prepare(`SELECT * FROM matches WHERE date >= ? ORDER BY date, time, id LIMIT 1`),
    upcomingPublic: db.prepare(`SELECT * FROM matches WHERE date >= ? AND status <> 'draft' ORDER BY date, time, id LIMIT 1`),
    latest: db.prepare('SELECT * FROM matches ORDER BY date DESC, id DESC LIMIT 1'),
    allMatches: db.prepare(`
      SELECT m.*, s.name AS season_name,
             (SELECT COUNT(*) FROM registrations r WHERE r.match_id = m.id)                                     AS registered,
             (SELECT COUNT(*) FROM registrations r WHERE r.match_id = m.id AND r.payment_status = 'paid')      AS paid,
             (SELECT COALESCE(SUM(price_cents),0) FROM registrations r WHERE r.match_id = m.id AND r.payment_status = 'paid') AS revenue_collected_cents,
             (SELECT COALESCE(SUM(price_cents),0) FROM registrations r WHERE r.match_id = m.id)                 AS revenue_expected_cents,
             (SELECT COUNT(*) FROM registrations r WHERE r.match_id = m.id AND r.attendance = 'present')       AS present
      FROM matches m LEFT JOIN seasons s ON s.id = m.season_id
      ORDER BY m.date DESC, m.id DESC`),
    linksByMatch: db.prepare('SELECT level, token FROM match_links WHERE match_id = ?'),
    linkByToken: db.prepare('SELECT * FROM match_links WHERE token = ?'),
    playerById: db.prepare('SELECT * FROM players WHERE id = ?'),
    playersByKey: db.prepare('SELECT * FROM players WHERE name_key = ? ORDER BY id'),
    playerSeason: db.prepare('SELECT * FROM player_seasons WHERE player_id = ? AND season_id = ?'),
    presentCount: db.prepare(`
      SELECT COUNT(*) AS n FROM registrations r JOIN matches m ON m.id = r.match_id
      WHERE r.player_id = ? AND m.season_id = ? AND r.attendance = 'present'`),
    seasonById: db.prepare('SELECT * FROM seasons WHERE id = ?'),
    deviceByHash: db.prepare('SELECT player_id FROM player_devices WHERE token_hash = ?'),
  };

  const seasonId = () => currentSeasonId(db);

  /* ---------- Saison / statut d'un joueur ---------- */

  function ensurePlayerSeason(playerId, sid) {
    db.prepare('INSERT OR IGNORE INTO player_seasons (player_id, season_id) VALUES (?, ?)').run(playerId, sid);
    return q.playerSeason.get(playerId, sid);
  }

  /** Participations validées = présences de la saison + correction manuelle. */
  function participations(playerId, sid) {
    const ps = q.playerSeason.get(playerId, sid);
    const n = q.presentCount.get(playerId, sid).n + (ps ? ps.participations_adjustment : 0);
    return Math.max(0, n);
  }

  function standingOf(playerId, sid) {
    const ps = q.playerSeason.get(playerId, sid);
    return standing(ps ? ps.subscription : 'none', participations(playerId, sid));
  }

  /* ---------- Vues ---------- */

  function linksOf(match) {
    const map = Object.fromEntries(q.linksByMatch.all(match.id).map((l) => [l.level, l.token]));
    return LINK_LEVELS.map((level) => ({ level, token: map[level], active: linkActive(match.status, level) }));
  }

  /**
   * Lien bancaire correspondant EXACTEMENT au montant enregistré sur l'inscription.
   * Jamais de repli sur un autre montant : pas de lien configuré pour ce montant → aucun lien.
   */
  function paymentLinkFor(priceCents) {
    if (!PAYMENT_LINK_AMOUNTS.includes(priceCents)) return '';
    return (getSetting(db, `payment_link_${priceCents}`, '') || '').trim();
  }

  /** Montants de ce match pour lesquels aucun lien carte n'est disponible. */
  function missingCardLinks(match) {
    return [...new Set([match.subscriber_price_cents, match.price_cents])].filter((c) => c > 0 && !paymentLinkFor(c));
  }

  function statsFor(match, regs) {
    const registered = regs.length;
    const count = (f) => regs.filter(f).length;
    const sum = (f) => regs.filter(f).reduce((a, r) => a + r.price_cents, 0);
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

  function adminMatchView(match) {
    const regs = q.regsByMatch.all(match.id);
    const season = match.season_id ? q.seasonById.get(match.season_id) : null;
    return {
      match: {
        ...match,
        is_past: match.date < today(),
        missing_card_links: missingCardLinks(match),
        season_name: season ? season.name : null,
      },
      links: linksOf(match),
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

  /** Vue publique : prénoms uniquement, jamais de paiement, de statut ni de lien. */
  function publicMatchView(match) {
    const regs = q.regsByMatch.all(match.id);
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

  /** Ce que le téléphone reconnu peut savoir de SON joueur. */
  function meView(playerId, match) {
    const p = playerId && q.playerById.get(playerId);
    if (!p) return null;
    const sid = match ? match.season_id : seasonId();
    const st = standingOf(p.id, sid);
    const reg = match ? q.regByPlayerMatch.get(match.id, p.id) : null;
    const price = match ? priceFor(st, match) : null;
    return {
      first_name: p.first_name,
      code: p.code,
      status_label: st.label,
      subscriber: st.subscriber,
      priority: st.priority,
      loyalty_eligible: st.loyalty_eligible,
      price_cents: price ? price.price_cents : null,
      registration: reg ? {
        payment_method: reg.payment_method,
        price_cents: reg.price_cents,
        tier: reg.tier,
        payment_link: reg.payment_method === 'card' ? paymentLinkFor(reg.price_cents) : '',
      } : null,
    };
  }

  function requireMatch(id) {
    const m = q.matchById.get(Number(id));
    if (!m) throw new AppError(404, 'not_found', 'Match introuvable.');
    return m;
  }

  function requireReg(id) {
    const r = q.regById.get(Number(id));
    if (!r) throw new AppError(404, 'not_found', 'Inscription introuvable.');
    return r;
  }

  function requirePlayer(id) {
    const p = q.playerById.get(Number(id));
    if (!p) throw new AppError(404, 'not_found', 'Joueur introuvable.');
    return p;
  }

  /** État d'un lien pour un match (ordre des vérifications identique à l'inscription). */
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
      if (!isValidTime(input.time)) throw new AppError(400, 'invalid_time', 'Heure invalide (format HH:MM).');
      out.time = input.time;
    }
    if (need('location')) {
      const loc = String(input.location ?? '').trim();
      if (!loc || loc.length > 120) throw new AppError(400, 'invalid_location', 'Indique un lieu (120 caractères max).');
      out.location = loc;
    }
    if (need('price_cents')) out.price_cents = cents('price_cents', 'Prix');
    if (has('subscriber_price_cents')) out.subscriber_price_cents = cents('subscriber_price_cents', 'Prix abonné');
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

  /* ---------- Inscription (cœur des règles) ---------- */

  function insertRegistration(match, playerId, { method, status, pricing, source }) {
    const p = q.playerById.get(playerId);
    const r = db.prepare(`
      INSERT INTO registrations (match_id, player_id, first_name, name_key, payment_method, payment_status, source, token, paid_at, price_cents, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(match.id, playerId, p.first_name, p.name_key, method, status, source, crypto.randomBytes(16).toString('hex'),
        status === 'paid' ? new Date().toISOString() : null, pricing.price_cents, pricing.tier);
    if (pricing.upgrade) {
      // 6e inscription après 5 participations validées : passage automatique en Abonné fidélité
      ensurePlayerSeason(playerId, match.season_id);
      db.prepare(`UPDATE player_seasons SET subscription = 'loyalty', subscribed_at = ? WHERE player_id = ? AND season_id = ? AND subscription = 'none'`)
        .run(new Date().toISOString(), playerId, match.season_id);
    }
    return q.regById.get(Number(r.lastInsertRowid));
  }

  /** Exécute fn dans une transaction immédiate (node:sqlite est synchrone : aucune course possible entre contrôle et écriture). */
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return {
    AppError,
    MSG,

    currentAdminMatch() {
      const m = q.upcomingAny.get(today());
      return m ? adminMatchView(m) : null;
    },

    /** Lien général : informations seulement (aucune inscription possible par ce biais). */
    currentPublicMatch(devicePlayerId) {
      const m = q.upcomingPublic.get(today());
      if (!m) return { current: null, me: null };
      return { current: publicMatchView(m), me: meView(devicePlayerId, m) };
    },

    publicMatch(id, devicePlayerId) {
      const m = q.matchById.get(Number(id));
      if (!m || m.status === 'draft') throw new AppError(404, 'not_found', 'Match introuvable.');
      return { current: publicMatchView(m), me: meView(devicePlayerId, m) };
    },

    /** Ouverture d'un lien d'inscription. Ne révèle jamais le niveau du lien ni les autres liens. */
    publicLink(token, devicePlayerId) {
      const link = typeof token === 'string' && token.length >= 20 && token.length <= 100 ? q.linkByToken.get(token) : null;
      const match = link ? q.matchById.get(link.match_id) : null;
      const state = linkState(match, link);
      if (state === 'invalid') return { state, message: MSG.invalid_link };
      const view = publicMatchView(match);
      return {
        state,
        message: state === 'open' ? null : MSG[state],
        priority_only: state === 'open' && phaseRequiresPriority(match.status),
        current: view,
        me: meView(devicePlayerId, match),
      };
    },

    /**
     * Inscription publique. Toutes les règles sont vérifiées ici :
     * lien + phase, identité, statut réel (jamais la déclaration), priorité, doublon, capacité, tarif.
     */
    registerPublic(matchId, input, { devicePlayerId = null } = {}) {
      const match = q.matchById.get(Number(matchId));
      const link = typeof input.link_token === 'string' && input.link_token.length <= 100 ? q.linkByToken.get(input.link_token) : null;
      const state = linkState(match, link);
      if (state === 'invalid') throw new AppError(404, 'invalid_link', MSG.invalid_link);
      if (state !== 'open') throw new AppError(403, state, MSG[state]);

      const method = input.payment_method;
      if (!METHODS.includes(method)) throw new AppError(400, 'method_required', 'Choisis ton mode de paiement.');
      const claims = input.claims_subscriber === true;
      const code = String(input.player_code ?? '').trim();
      if (code && !/^\d{4}$/.test(code)) throw new AppError(400, 'bad_code_format', 'Le code joueur contient 4 chiffres.');

      // 1. Identification du joueur
      let player = null;
      let newName = null;
      const useDevice = devicePlayerId && input.as_other !== true && q.playerById.get(devicePlayerId);
      if (useDevice) {
        player = q.playerById.get(devicePlayerId);
      } else {
        const name = cleanFirstName(input.first_name);
        const candidates = q.playersByKey.all(normalizeName(name));
        if (code) {
          player = candidates.find((p) => crypto.timingSafeEqual(Buffer.from(p.code), Buffer.from(code))) || null;
          if (!player) {
            throw new AppError(403, claims ? 'subscriber_not_recognized' : 'bad_code',
              claims ? MSG.subscriber_not_recognized : 'Code joueur incorrect. Vérifie-le ou contacte l’organisateur.', { code_failed: true });
          }
        } else if (candidates.length === 0) {
          if (claims) throw new AppError(403, 'subscriber_not_recognized', MSG.subscriber_not_recognized);
          newName = name;
        } else if (claims) {
          throw new AppError(409, 'code_required', MSG.code_required);
        } else {
          throw new AppError(409, 'name_taken', MSG.name_taken);
        }
      }

      // 2. Statut réel (fiche joueur) — la déclaration « je suis abonné » ne donne jamais le tarif abonné
      const st = player ? standingOf(player.id, match.season_id) : standing('none', 0);
      if (claims && !st.subscriber && !st.loyalty_eligible) {
        throw new AppError(403, 'subscriber_not_recognized', MSG.subscriber_not_recognized);
      }

      // 3. Priorité : en phase Prioritaires, le lien ne suffit pas
      if (phaseRequiresPriority(match.status) && !st.priority) {
        throw new AppError(403, 'priority_only', MSG.priority_only);
      }

      // 4. Doublon + capacité + écriture (atomique)
      return tx(() => {
        if (player) {
          const existing = q.regByPlayerMatch.get(match.id, player.id);
          if (existing) throw new AppError(409, 'already_registered', MSG.already_registered, { player_id: player.id });
        }
        if (q.countByMatch.get(match.id).n >= match.capacity) throw new AppError(409, 'full', MSG.full);
        const playerId = player ? player.id : createPlayer(db, { first_name: newName, season_id: match.season_id });
        const pricing = priceFor(st, match);
        const reg = insertRegistration(match, playerId, { method, status: defaultStatusFor(method), pricing, source: 'player' });
        const p = q.playerById.get(playerId);
        return {
          player_id: playerId,
          created_player: !player,
          registration: {
            id: reg.id,
            first_name: p.first_name,
            payment_method: reg.payment_method,
            price_cents: reg.price_cents,
            tier: reg.tier,
            loyalty_upgrade: pricing.upgrade,
            subscriber: pricing.tier !== 'standard',
            player_code: p.code,
          },
          payment_link: method === 'card' ? paymentLinkFor(reg.price_cents) : '',
          current: publicMatchView(match),
        };
      });
    },

    /** Ajout par l'organisateur : ignore phase et priorité, jamais la capacité. */
    registerAdmin(matchId, input) {
      const match = requireMatch(matchId);
      const method = input.payment_method;
      if (!METHODS.includes(method)) throw new AppError(400, 'method_required', 'Choisis le mode de paiement.');
      let status = defaultStatusFor(method);
      if (input.payment_status !== undefined) {
        if (!PAY_STATUSES.includes(input.payment_status)) throw new AppError(400, 'invalid_payment_status', 'Statut de paiement invalide.');
        status = input.payment_status === 'paid' ? 'paid' : defaultStatusFor(method);
      }
      const existingPlayer = input.player_id ? requirePlayer(input.player_id) : null;
      const newName = existingPlayer ? null : cleanFirstName(input.first_name);
      return tx(() => {
        if (existingPlayer && q.regByPlayerMatch.get(match.id, existingPlayer.id)) {
          throw new AppError(409, 'already_registered', `${existingPlayer.first_name} est déjà inscrit à ce match.`);
        }
        if (q.countByMatch.get(match.id).n >= match.capacity) throw new AppError(409, 'full', MSG.full);
        // Un nouveau prénom crée toujours une nouvelle fiche (homonymes autorisés pour l'organisateur)
        const playerId = existingPlayer ? existingPlayer.id : createPlayer(db, { first_name: newName, season_id: match.season_id });
        const pricing = priceFor(standingOf(playerId, match.season_id), match);
        insertRegistration(match, playerId, { method, status, pricing, source: 'admin' });
        return adminMatchView(match);
      });
    },

    /* ---------- Téléphones reconnus ---------- */

    playerFromDevice(token) {
      if (!token || typeof token !== 'string' || token.length > 100) return null;
      const row = q.deviceByHash.get(hashDevice(token));
      return row ? row.player_id : null;
    },

    issueDevice(playerId) {
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO player_devices (token_hash, player_id, last_seen_at) VALUES (?, ?, ?)').run(hashDevice(token), playerId, new Date().toISOString());
      return token;
    },

    forgetDevice(token) {
      if (token) db.prepare('DELETE FROM player_devices WHERE token_hash = ?').run(hashDevice(token));
    },

    /* ---------- Matchs (admin) ---------- */

    adminMatch(id) {
      return adminMatchView(requireMatch(id));
    },

    listMatches() {
      const t = today();
      return q.allMatches.all().map((m) => ({
        ...m,
        is_past: m.date < t,
        unpaid: m.registered - m.paid,
      }));
    },

    /** Valeurs pré-remplies pour « Créer le prochain foot ». */
    nextDefaults() {
      const last = q.latest.get();
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

    createMatch(input) {
      const m = parseMatchInput(input);
      const r = db
        .prepare('INSERT INTO matches (date, time, location, price_cents, subscriber_price_cents, capacity, status, payment_link, season_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(m.date, m.time, m.location, m.price_cents, m.subscriber_price_cents, m.capacity, m.status, m.payment_link, seasonId());
      ensureMatchLinks(db, Number(r.lastInsertRowid));
      return adminMatchView(requireMatch(r.lastInsertRowid));
    },

    updateMatch(id, input) {
      requireMatch(id);
      const m = parseMatchInput(input, { partial: true });
      const keys = Object.keys(m);
      if (keys.length) {
        db.prepare(`UPDATE matches SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => m[k]), Number(id));
      }
      return adminMatchView(requireMatch(id));
    },

    deleteMatch(id) {
      requireMatch(id);
      db.prepare('DELETE FROM matches WHERE id = ?').run(Number(id));
    },

    /** Régénère les 3 liens d'un match (en cas de lien partagé par erreur). */
    regenerateLinks(id) {
      const m = requireMatch(id);
      tx(() => {
        db.prepare('DELETE FROM match_links WHERE match_id = ?').run(m.id);
        ensureMatchLinks(db, m.id);
      });
      return adminMatchView(m);
    },

    /* ---------- Inscriptions (admin) ---------- */

    updateRegistration(id, input) {
      const reg = requireReg(id);
      const patch = {};
      const method = input.payment_method !== undefined ? input.payment_method : reg.payment_method;
      if (!METHODS.includes(method)) throw new AppError(400, 'invalid_method', 'Mode de paiement invalide.');
      if (input.payment_method !== undefined) patch.payment_method = method;

      if (input.payment_status !== undefined) {
        if (!PAY_STATUSES.includes(input.payment_status)) throw new AppError(400, 'invalid_payment_status', 'Statut de paiement invalide.');
        patch.payment_status = input.payment_status === 'paid' ? 'paid' : defaultStatusFor(method);
      } else if (input.payment_method !== undefined && reg.payment_status !== 'paid') {
        patch.payment_status = defaultStatusFor(method); // « non payé » suit le mode de paiement
      }
      if (patch.payment_status) patch.paid_at = patch.payment_status === 'paid' ? reg.paid_at || new Date().toISOString() : null;

      if (input.price_cents !== undefined) {
        const p = Number(input.price_cents);
        if (!Number.isInteger(p) || p < 0 || p > 100000) throw new AppError(400, 'invalid_price', 'Tarif invalide.');
        patch.price_cents = p;
      }
      if (input.attendance !== undefined) {
        if (!ATTENDANCES.includes(input.attendance)) throw new AppError(400, 'invalid_attendance', 'Présence invalide.');
        patch.attendance = input.attendance;
        patch.attendance_at = input.attendance === 'unknown' ? null : new Date().toISOString();
      }
      const keys = Object.keys(patch);
      if (keys.length) {
        db.prepare(`UPDATE registrations SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), reg.id);
      }
      return adminMatchView(requireMatch(reg.match_id));
    },

    deleteRegistration(id) {
      const reg = requireReg(id);
      db.prepare('DELETE FROM registrations WHERE id = ?').run(reg.id);
      return adminMatchView(requireMatch(reg.match_id));
    },

    /* ---------- Joueurs (admin) ---------- */

    listPlayers() {
      const sid = seasonId();
      const next = this.nextDefaults();
      const rows = db.prepare(`
        SELECT p.*, COALESCE(ps.subscription, 'none') AS subscription, COALESCE(ps.participations_adjustment, 0) AS adjustment,
               (SELECT COUNT(*) FROM registrations r JOIN matches m ON m.id = r.match_id
                 WHERE r.player_id = p.id AND m.season_id = ? AND r.attendance = 'present') AS present_season,
               (SELECT COUNT(*) FROM registrations r WHERE r.player_id = p.id) AS registrations_total,
               (SELECT MAX(m.date) FROM registrations r JOIN matches m ON m.id = r.match_id WHERE r.player_id = p.id) AS last_match
        FROM players p LEFT JOIN player_seasons ps ON ps.player_id = p.id AND ps.season_id = ?
        ORDER BY p.first_name COLLATE NOCASE, p.id`).all(sid, sid);
      return rows.map((r) => {
        const st = standing(r.subscription, Math.max(0, r.present_season + r.adjustment));
        const price = priceFor(st, next);
        return {
          id: r.id,
          first_name: r.first_name,
          code: r.code,
          is_demo: !!r.is_demo,
          ...st,
          price_cents: price.price_cents,
          registrations_total: r.registrations_total,
          last_match: r.last_match,
          homonyms: rows.filter((o) => o.name_key === r.name_key).length > 1,
        };
      });
    },

    createPlayerAdmin(input) {
      const name = cleanFirstName(input.first_name);
      const sub = input.subscription ?? 'none';
      if (!SUBSCRIPTIONS.includes(sub)) throw new AppError(400, 'invalid_subscription', 'Statut invalide.');
      const id = createPlayer(db, { first_name: name, season_id: seasonId(), subscription: sub });
      return this.playerDetail(id);
    },

    playerDetail(id) {
      const p = requirePlayer(id);
      const sid = seasonId();
      ensurePlayerSeason(p.id, sid);
      const st = standingOf(p.id, sid);
      const history = db.prepare(`
        SELECT r.id, r.match_id, r.price_cents, r.tier, r.attendance, r.payment_status, r.payment_method,
               m.date, m.time, m.location, m.season_id, s.name AS season_name
        FROM registrations r JOIN matches m ON m.id = r.match_id LEFT JOIN seasons s ON s.id = m.season_id
        WHERE r.player_id = ? ORDER BY m.date DESC, m.id DESC`).all(p.id);
      const seasons = db.prepare(`
        SELECT s.id, s.name, s.is_current, ps.subscription, ps.participations_adjustment
        FROM player_seasons ps JOIN seasons s ON s.id = ps.season_id
        WHERE ps.player_id = ? ORDER BY s.id DESC`).all(p.id).map((s) => ({
        ...s,
        label: SUBSCRIPTION_LABEL[s.subscription],
        participations: participations(p.id, s.id),
      }));
      const homonyms = q.playersByKey.all(p.name_key).filter((o) => o.id !== p.id).map((o) => ({ id: o.id, first_name: o.first_name }));
      const next = this.nextDefaults();
      return {
        player: {
          id: p.id,
          first_name: p.first_name,
          code: p.code,
          created_at: p.created_at,
          is_demo: !!p.is_demo,
          ...st,
          price_cents: priceFor(st, next).price_cents,
          present_season: q.presentCount.get(p.id, sid).n,
          adjustment: q.playerSeason.get(p.id, sid).participations_adjustment,
          devices: db.prepare('SELECT COUNT(*) AS n FROM player_devices WHERE player_id = ?').get(p.id).n,
        },
        stats: {
          matches: history.length,
          present: history.filter((h) => h.attendance === 'present').length,
          absent: history.filter((h) => h.attendance === 'absent').length,
          unknown: history.filter((h) => h.attendance === 'unknown').length,
          billed_cents: history.reduce((a, h) => a + h.price_cents, 0),
          paid_cents: history.filter((h) => h.payment_status === 'paid').reduce((a, h) => a + h.price_cents, 0),
        },
        history: history.map((h) => ({ ...h, tier_label: TIER_LABEL[h.tier], is_past: h.date < today() })),
        seasons,
        homonyms,
        season_id: sid,
      };
    },

    updatePlayer(id, input) {
      const p = requirePlayer(id);
      const sid = seasonId();
      tx(() => {
        ensurePlayerSeason(p.id, sid);
        if (input.first_name !== undefined) {
          const name = cleanFirstName(input.first_name);
          const key = normalizeName(name);
          let code = p.code;
          if (key !== p.name_key && q.playersByKey.all(key).some((o) => o.code === p.code)) code = newPlayerCode(db, key);
          db.prepare('UPDATE players SET first_name = ?, name_key = ?, code = ? WHERE id = ?').run(name, key, code, p.id);
        }
        if (input.subscription !== undefined) {
          if (!SUBSCRIPTIONS.includes(input.subscription)) throw new AppError(400, 'invalid_subscription', 'Statut invalide.');
          db.prepare('UPDATE player_seasons SET subscription = ?, subscribed_at = ? WHERE player_id = ? AND season_id = ?')
            .run(input.subscription, input.subscription === 'none' ? null : new Date().toISOString(), p.id, sid);
        }
        if (input.participations !== undefined) {
          const target = Number(input.participations);
          if (!Number.isInteger(target) || target < 0 || target > 500) throw new AppError(400, 'invalid_participations', 'Nombre de participations invalide.');
          const present = q.presentCount.get(p.id, sid).n;
          db.prepare('UPDATE player_seasons SET participations_adjustment = ? WHERE player_id = ? AND season_id = ?').run(target - present, p.id, sid);
        }
        if (input.regenerate_code === true) {
          db.prepare('UPDATE players SET code = ? WHERE id = ?').run(newPlayerCode(db, q.playerById.get(p.id).name_key), p.id);
        }
        if (input.forget_devices === true) {
          db.prepare('DELETE FROM player_devices WHERE player_id = ?').run(p.id);
        }
      });
      return this.playerDetail(p.id);
    },

    /** Fusionne la fiche `sourceId` dans `targetId` (doublon d'une même personne). */
    mergePlayers(sourceId, targetId) {
      const src = requirePlayer(sourceId);
      const dst = requirePlayer(targetId);
      if (src.id === dst.id) throw new AppError(400, 'same_player', 'Choisis deux fiches différentes.');
      const conflicts = db.prepare(`
        SELECT m.date FROM registrations a JOIN registrations b ON a.match_id = b.match_id JOIN matches m ON m.id = a.match_id
        WHERE a.player_id = ? AND b.player_id = ?`).all(src.id, dst.id);
      if (conflicts.length) {
        throw new AppError(409, 'merge_conflict',
          `Les deux fiches sont inscrites au même match (${conflicts.map((c) => c.date).join(', ')}). Supprime d’abord l’une des deux inscriptions.`);
      }
      const rank = { none: 0, loyalty: 1, annual: 2 };
      tx(() => {
        db.prepare('UPDATE registrations SET player_id = ? WHERE player_id = ?').run(dst.id, src.id);
        db.prepare('UPDATE player_devices SET player_id = ? WHERE player_id = ?').run(dst.id, src.id);
        for (const s of db.prepare('SELECT * FROM player_seasons WHERE player_id = ?').all(src.id)) {
          const d = q.playerSeason.get(dst.id, s.season_id);
          if (!d) {
            db.prepare('UPDATE player_seasons SET player_id = ? WHERE player_id = ? AND season_id = ?').run(dst.id, src.id, s.season_id);
          } else {
            const best = rank[s.subscription] > rank[d.subscription] ? s : d;
            db.prepare('UPDATE player_seasons SET subscription = ?, subscribed_at = ?, participations_adjustment = ? WHERE player_id = ? AND season_id = ?')
              .run(best.subscription, best.subscribed_at, d.participations_adjustment + s.participations_adjustment, dst.id, s.season_id);
          }
        }
        db.prepare('DELETE FROM players WHERE id = ?').run(src.id);
      });
      return this.playerDetail(dst.id);
    },

    deletePlayer(id) {
      const p = requirePlayer(id);
      const n = db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE player_id = ?').get(p.id).n;
      if (n) throw new AppError(409, 'has_registrations', 'Ce joueur a un historique de matchs : fusionne-le plutôt avec la bonne fiche.');
      db.prepare('DELETE FROM players WHERE id = ?').run(p.id);
    },

    /* ---------- Saisons ---------- */

    listSeasons() {
      return db.prepare(`
        SELECT s.*,
          (SELECT COUNT(*) FROM matches m WHERE m.season_id = s.id) AS matches,
          (SELECT COUNT(*) FROM player_seasons ps WHERE ps.season_id = s.id AND ps.subscription <> 'none') AS subscribers
        FROM seasons s ORDER BY s.id DESC`).all();
    },

    /** Nouvelle saison : compteurs à zéro, rien n'est supprimé (les anciennes saisons restent consultables). */
    startSeason(input) {
      const name = String(input.name ?? '').trim() || seasonFor(today()).name;
      if (name.length > 40) throw new AppError(400, 'invalid_name', 'Nom de saison trop long.');
      const start = isValidDate(input.start_date) ? input.start_date : today();
      const prev = seasonId();
      return tx(() => {
        db.prepare('UPDATE seasons SET is_current = 0').run();
        const sid = Number(db.prepare('INSERT INTO seasons (name, start_date, is_current) VALUES (?, ?, 1)').run(name, start).lastInsertRowid);
        if (input.carry_annual === true && prev) {
          db.prepare(`INSERT INTO player_seasons (player_id, season_id, subscription, subscribed_at)
                      SELECT player_id, ?, 'annual', ? FROM player_seasons WHERE season_id = ? AND subscription = 'annual'`)
            .run(sid, new Date().toISOString(), prev);
        }
        // Les matchs à venir basculent dans la nouvelle saison ; les matchs passés restent dans l'ancienne.
        db.prepare('UPDATE matches SET season_id = ? WHERE date >= ?').run(sid, start);
        return this.listSeasons();
      });
    },

    currentSeason() {
      return q.seasonById.get(seasonId());
    },

    /* ---------- Démo ---------- */

    clearDemo() {
      return tx(() => {
        const r = db.prepare('DELETE FROM matches WHERE is_demo = 1').run();
        db.prepare('DELETE FROM players WHERE is_demo = 1 AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.player_id = players.id)').run();
        return r.changes;
      });
    },

    hasDemo() {
      return !!db.prepare('SELECT 1 FROM matches WHERE is_demo = 1 UNION SELECT 1 FROM players WHERE is_demo = 1 LIMIT 1').get();
    },

    LOYALTY_THRESHOLD,
    paymentLinkFor,
  };
}

module.exports = { createRepo, AppError, cleanFirstName, PAYMENT_LINK_AMOUNTS };
