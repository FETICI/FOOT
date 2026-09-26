/* Utilitaires partagés entre la page joueur et l'administration. */
(function (global) {
  'use strict';

  const TZ = 'Europe/Paris';

  function parseDay(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12));
  }

  const fmtLong = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const fmtLongYear = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const fmtDayMonth = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const fmtClock = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  const fmtShortDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', timeZone: TZ });
  const fmtIsoDay = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const F = {
    /** « Vendredi 2 octobre » */
    dayLong: (iso, withYear = false) => cap((withYear ? fmtLongYear : fmtLong).format(parseDay(iso))),
    /** « 2 octobre » */
    dayMonth: (iso) => fmtDayMonth.format(parseDay(iso)),
    /** « 20h00 » */
    time: (hhmm) => hhmm.replace(':', 'h'),
    /** « 10 € » / « 7,50 € » */
    price: (cents) => {
      const e = cents / 100;
      return (Number.isInteger(e) ? String(e) : e.toFixed(2).replace('.', ',')) + ' €';
    },
    /** Heure d'inscription : « 18:32 » si aujourd'hui, sinon « lun. 28 · 18:32 » */
    stamp: (isoTs) => {
      const d = new Date(isoTs);
      const clock = fmtClock.format(d);
      return fmtIsoDay.format(d) === fmtIsoDay.format(new Date()) ? clock : `${fmtShortDay.format(d)} · ${clock}`;
    },
    today: () => fmtIsoDay.format(new Date()),
    plural: (n, one, many) => `${n} ${n > 1 ? many : one}`,
  };

  /** Petit créateur d'éléments : h('div.card', {onclick}, [enfants]). Texte toujours échappé. */
  function h(tag, attrs, children) {
    if (Array.isArray(attrs) || typeof attrs === 'string' || attrs instanceof Node) {
      children = attrs;
      attrs = {};
    }
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'html') el.innerHTML = v; // réservé aux icônes SVG internes
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    if (children == null || children === false) return;
    if (Array.isArray(children)) children.forEach((c) => append(el, c));
    else el.append(children instanceof Node ? children : document.createTextNode(String(children)));
  }

  const svg = (path, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${path}</svg>`;

  const ICONS = {
    ball: svg('<circle cx="12" cy="12" r="9.5"/><path d="m12 7.5 4 2.9-1.5 4.7h-5L8 10.4z"/><path d="M12 2.5v5M16 10.4l4.6-1.6M14.5 15.1l2.8 4M9.5 15.1l-2.8 4M8 10.4 3.4 8.8"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    pin: svg('<path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
    euro: svg('<path d="M17 6.5A7 7 0 1 0 17 17.5"/><path d="M4 10h9M4 14h9"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 'stroke-width="3"'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
    share: svg('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    minus: svg('<path d="M5 12h14"/>'),
    edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
    back: svg('<path d="M15 18l-6-6 6-6"/>'),
    chevron: svg('<path d="m9 6 6 6-6 6"/>'),
    card: svg('<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/>'),
    external: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'),
    calendar: svg('<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
    history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    logout: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/>'),
    users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6"/>'),
    lock: svg('<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>'),
  };
  const icon = (name) => h('span', { html: ICONS[name], style: 'display:inline-flex' });

  /** Appel API JSON. Rejette { status, error, message }. */
  async function api(method, url, body) {
    const write = method !== 'GET';
    let res;
    try {
      res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: write ? { 'Content-Type': 'application/json' } : {},
        body: write ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch {
      throw { status: 0, error: 'network', message: 'Connexion impossible. Vérifie ton réseau et réessaie.' };
    }
    let data = {};
    try { data = await res.json(); } catch { /* vide */ }
    if (!res.ok) throw { ...data, status: res.status, error: data.error || 'error', message: data.message || 'Une erreur est survenue.' };
    return data;
  }

  let toastTimer;
  function toast(msg, kind = '') {
    let el = document.querySelector('.toast');
    if (!el) {
      el = h('div.toast', { role: 'status', 'aria-live': 'polite' });
      document.body.append(el);
    }
    el.textContent = msg;
    el.className = 'toast ' + kind;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = h('textarea', { style: 'position:fixed;top:-100px;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  const PHASES = {
    draft: { label: 'Brouillon', long: 'Brouillon (non visible)', sub: 'Invisible pour les joueurs' },
    priority: { label: 'Prioritaires', long: 'Prioritaires', sub: 'Lundi · abonnés uniquement' },
    open: { label: 'Ouvert', long: 'Ouvert à tous', sub: 'Mardi · tout le monde' },
    invite: { label: 'Invitations', long: 'Invitations', sub: 'Mercredi · lien invitations' },
    closed: { label: 'Fermé', long: 'Fermé', sub: 'Plus d’inscriptions' },
  };

  global.FDV = { F, h, icon, ICONS, api, toast, copyText, PHASES };
})(window);
