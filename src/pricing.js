'use strict';
/**
 * Règles commerciales — tarifs, abonnements, priorité.
 * Module pur (aucun accès base) : c'est la seule source de vérité pour le calcul
 * du tarif et de la priorité, toujours exécutée côté serveur.
 */

/** Nombre de participations validées qui déclenche l'abonnement fidélité à l'inscription suivante. */
const LOYALTY_THRESHOLD = 5;

const SUBSCRIPTIONS = ['none', 'annual', 'loyalty'];

const SUBSCRIPTION_LABEL = {
  none: 'Non abonné',
  annual: 'Abonné annuel',
  loyalty: 'Abonné fidélité',
};

/**
 * Situation d'un joueur pour la saison.
 * @param {string} subscription  'none' | 'annual' | 'loyalty'
 * @param {number} participations  participations validées (présences) de la saison
 */
function standing(subscription, participations) {
  const sub = SUBSCRIPTIONS.includes(subscription) ? subscription : 'none';
  const eligible = sub === 'none' && participations >= LOYALTY_THRESHOLD;
  const subscriber = sub === 'annual' || sub === 'loyalty';
  return {
    subscription: sub,
    label: SUBSCRIPTION_LABEL[sub],
    subscriber,
    /** Non abonné ayant déjà 5 participations : sa prochaine inscription le fait passer Abonné fidélité. */
    loyalty_eligible: eligible,
    /** Prioritaire = abonné annuel, abonné fidélité, ou fidélité acquise à la prochaine inscription. */
    priority: subscriber || eligible,
    participations,
    progress: Math.min(participations, LOYALTY_THRESHOLD),
    threshold: LOYALTY_THRESHOLD,
  };
}

/**
 * Tarif d'une inscription.
 * @returns {{price_cents:number, tier:'annual'|'loyalty'|'loyalty_upgrade'|'standard', upgrade:boolean}}
 */
function priceFor(st, match) {
  if (st.subscription === 'annual') return { price_cents: match.subscriber_price_cents, tier: 'annual', upgrade: false };
  if (st.subscription === 'loyalty') return { price_cents: match.subscriber_price_cents, tier: 'loyalty', upgrade: false };
  if (st.loyalty_eligible) return { price_cents: match.subscriber_price_cents, tier: 'loyalty_upgrade', upgrade: true };
  return { price_cents: match.price_cents, tier: 'standard', upgrade: false };
}

/* ---------- Phases et liens ---------- */

const LINK_LEVELS = ['priority', 'open', 'invite'];

/** Niveaux de lien acceptés pour chaque phase du match. */
const PHASE_ACCEPTS = {
  draft: [],
  priority: ['priority'],
  open: ['priority', 'open'],
  invite: ['priority', 'open', 'invite'],
  closed: [],
};

function linkActive(phase, level) {
  return (PHASE_ACCEPTS[phase] || []).includes(level);
}

/** En phase Prioritaires, seuls les joueurs prioritaires peuvent s'inscrire (quel que soit le lien). */
function phaseRequiresPriority(phase) {
  return phase === 'priority';
}

const TIER_LABEL = {
  annual: 'Abonné annuel',
  loyalty: 'Abonné fidélité',
  loyalty_upgrade: 'Abonné fidélité',
  standard: 'Non abonné',
};

module.exports = {
  LOYALTY_THRESHOLD,
  SUBSCRIPTIONS,
  SUBSCRIPTION_LABEL,
  TIER_LABEL,
  LINK_LEVELS,
  standing,
  priceFor,
  linkActive,
  phaseRequiresPriority,
};
