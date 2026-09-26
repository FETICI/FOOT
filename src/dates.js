'use strict';
// Toutes les dates « métier » sont exprimées dans le fuseau du groupe (Europe/Paris par défaut).
const TZ = process.env.TZ_GROUP || 'Europe/Paris';

const isoDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Date du jour (YYYY-MM-DD) dans le fuseau du groupe. */
function today() {
  return isoDayFmt.format(new Date());
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function weekday(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = dimanche, 5 = vendredi
}

/** Prochain vendredi à partir de `from` (inclus). */
function nextFriday(from = today()) {
  const diff = (5 - weekday(from) + 7) % 7;
  return addDays(from, diff);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

module.exports = { TZ, today, addDays, nextFriday, isValidDate, isValidTime };
