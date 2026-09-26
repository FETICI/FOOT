'use strict';
/**
 * Numéros de téléphone : normalisation au format international (E.164).
 *   06 12 34 56 78 · 0612345678 · 06.12.34.56.78 · 06-12-34-56-78 · +33 6 12 34 56 78 · 0033612345678
 *   → +33612345678
 * Un numéro déjà saisi avec son indicatif (+44…, 0044…) est conservé tel quel (chiffres uniquement).
 */

/**
 * @returns {string|null} numéro normalisé (+XXXXXXXX) ou null si invalide
 */
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s || s.length > 30) return null;
  // Seuls chiffres, espaces, + . - ( ) / sont acceptés
  if (!/^[+\d\s.\-()/]+$/.test(s)) return null;
  const plus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  let intl;
  if (plus) intl = digits;
  else if (digits.startsWith('00')) intl = digits.slice(2);
  else if (digits.length === 10 && digits.startsWith('0')) intl = `33${digits.slice(1)}`; // numéro français national
  else if (digits.length === 11 && digits.startsWith('33')) intl = digits;               // 33612345678 sans « + »
  else return null;

  // France : +33 suivi de 9 chiffres (le 0 national éventuellement recopié est retiré : +33 06… → +336…)
  if (intl.startsWith('330') && intl.length === 12) intl = `33${intl.slice(3)}`;
  if (intl.startsWith('33')) {
    if (!/^33[1-9]\d{8}$/.test(intl)) return null;
    return `+${intl}`;
  }
  // International : indicatif ≠ 0, 8 à 15 chiffres au total (norme E.164)
  if (!/^[1-9]\d{7,14}$/.test(intl)) return null;
  return `+${intl}`;
}

/** Affichage lisible : +33612345678 → 06 12 34 56 78 ; autres pays inchangés. */
function formatPhone(normalized) {
  if (!normalized) return '';
  const m = /^\+33(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(normalized);
  return m ? `0${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}` : normalized;
}

module.exports = { normalizePhone, formatPhone };
