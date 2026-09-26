/* Page joueur.
 *  /i/<jeton>   lien d'inscription (Prioritaires / Ouvert / Invitations)
 *  /  et /m/<id> informations du prochain match (sans inscription)
 * Identification : prénom + numéro de téléphone. Toutes les règles (phase, lien, fiche joueur,
 * tarif, lien bancaire, capacité) sont décidées par le serveur.
 */
(function () {
  'use strict';
  const { F, h, icon, api, ICONS } = window.FDV;
  const app = document.getElementById('app');

  const linkMatch = location.pathname.match(/^\/i\/([A-Za-z0-9_-]{1,100})$/);
  const idMatch = location.pathname.match(/^\/m\/(\d+)$/);
  const LINK_TOKEN = linkMatch ? linkMatch[1] : null;
  const endpoint = LINK_TOKEN ? `/api/public/links/${LINK_TOKEN}` : idMatch ? `/api/public/matches/${idMatch[1]}` : '/api/public/match';

  const EYEBROW = {
    priority: 'Inscriptions · Prioritaires',
    open: 'Inscriptions ouvertes',
    invite: 'Inscriptions · Invitations',
    closed: 'Inscriptions fermées',
  };

  /* Pré-remplissage : ce téléphone retient le prénom et le numéro saisis (localement uniquement).
     Ce n'est qu'un confort de saisie : le serveur identifie toujours le joueur par son numéro. */
  const SAVED_KEY = 'fdv:me';
  const saved = {
    get() { try { const v = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null'); return v && v.first_name && v.phone ? v : null; } catch { return null; } },
    set(v) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(v)); } catch { /* navigation privée */ } },
    clear() { try { localStorage.removeItem(SAVED_KEY); } catch { /* ignore */ } },
  };

  const state = {
    res: null,             // réponse serveur (lien ou infos)
    confirmation: null,    // inscription confirmée
    notice: null,          // message au-dessus de la confirmation (ex. « déjà inscrit »)
    blocked: null,         // message bloquant (réservé aux prioritaires)
    forOther: false,       // inscription d'une autre personne depuis ce téléphone
    form: { name: '', phone: '', method: '' },
    submitting: false,
    error: null,
    errorField: null,
  };

  const d = () => state.res && state.res.current;

  /* =========================================================
     Blocs d'affichage
     ========================================================= */

  function hero(v) {
    const m = v.match;
    const pct = Math.min(100, Math.round((v.registered / m.capacity) * 100));
    const full = v.remaining === 0;
    const leftClass = full ? 'none' : v.remaining <= 3 ? 'low' : '';
    return h('section.hero', { 'aria-label': 'Informations du match' }, [
      h('span.eyebrow', EYEBROW[m.status] || 'Inscriptions'),
      h('h1', ['Foot du', h('br'), 'vendredi']),
      h('p.date-line', F.dayLong(m.date)),
      h('div.chips', [
        h('span.chip.num', [icon('clock'), F.time(m.time)]),
        h('span.chip', [icon('pin'), m.location]),
        h('span.chip.num', [icon('euro'), F.price(m.price_cents), m.subscriber_price_cents < m.price_cents ? h('span.chip-sub', ` · ${F.price(m.subscriber_price_cents)} abonnés`) : null]),
      ]),
      h('div.capacity', [
        h('div.capacity-top', [
          h('div', [
            h('div.capacity-count.num', [String(v.registered), h('small', ` / ${m.capacity}`)]),
            h('div.capacity-label', 'joueurs inscrits'),
          ]),
          h(`div.capacity-left.num.${leftClass}`, full ? 'Complet' : F.plural(v.remaining, 'place restante', 'places restantes')),
        ]),
        h(`div.bar${full ? '.full' : ''}`, { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': m.capacity, 'aria-valuenow': v.registered }, h('span', { style: `width:${pct}%` })),
      ]),
    ]);
  }

  function stateCard(emoji, title, text, extra) {
    return h('section.card.state-card', [h('div.big-emoji', emoji), h('h2', title), text ? h('p', text) : null, extra || null]);
  }

  function choiceButtons(name, current, options, onPick) {
    return h('div.pay-choice', options.map(([value, emoji, title, sub]) => h('div.pay-option', [
      h('input', { type: 'radio', name, id: `${name}-${value}`, value: String(value), checked: current === value, onchange: () => onPick(value) }),
      h('label', { for: `${name}-${value}` }, [emoji ? h('span.emoji', { 'aria-hidden': 'true' }, emoji) : null, h('span.t', title), sub ? h('span.s', sub) : null]),
    ])));
  }

  function form() {
    const f = state.form;
    const children = [];

    if (state.res.priority_only) {
      children.push(h('div.alert.info', [h('span.ico', '⭐'), h('span', 'Inscriptions réservées aux joueurs prioritaires (abonnés) pour le moment.')]));
    }
    if (state.forOther) {
      children.push(h('div.row.between', [
        h('p.label', 'Inscrire une autre personne'),
        h('button.btn-link', { type: 'button', onclick: () => { state.forOther = false; resetForm(); render(); } }, 'Annuler'),
      ]));
    }

    const nameInput = h('input.input', {
      id: 'first-name', name: 'first_name', type: 'text', required: true, maxlength: 30,
      autocomplete: state.forOther ? 'off' : 'given-name', autocapitalize: 'words', enterkeyhint: 'next',
      placeholder: 'Ex. Thomas', value: f.name,
      oninput: (e) => { f.name = e.target.value; clearError(); syncSubmit(); },
    });
    nameInput.spellcheck = false;
    const phoneInput = h('input.input', {
      id: 'phone', name: 'phone', type: 'tel', required: true, maxlength: 20,
      autocomplete: state.forOther ? 'off' : 'tel', inputmode: 'tel', enterkeyhint: 'done',
      placeholder: 'Ex. 06 12 34 56 78', value: f.phone,
      oninput: (e) => { f.phone = e.target.value; clearError(); syncSubmit(); },
    });
    if (state.errorField === 'phone') phoneInput.classList.add('invalid');

    children.push(h('div.field', [h('label.label', { for: 'first-name' }, 'Prénom'), nameInput]));
    children.push(h('div.field', [
      h('label.label', { for: 'phone' }, 'Numéro de téléphone'),
      phoneInput,
      h('p.hint', 'Il sert uniquement à te reconnaître (tarif, abonnement). Jamais affiché publiquement.'),
    ]));

    children.push(h('fieldset.field.plain', [
      h('legend.label', 'Mode de paiement'),
      choiceButtons('payment_method', f.method, [['card', '💳', 'Payer par carte', 'Lien de paiement'], ['cash', '💶', 'Payer en espèces', 'Sur place']], (val) => {
        f.method = val; clearError(); syncSubmit();
      }),
    ]));

    const errorSlot = h('div.error-slot', { id: 'form-error' });
    if (state.error) errorSlot.append(h('div.alert.error', { role: 'alert' }, [h('span.ico', '⚠️'), h('span', state.error)]));
    children.push(errorSlot);
    children.push(h('p.hint.center', 'Ton tarif (5 € abonné ou 10 €) est calculé automatiquement.'));
    children.push(h('button.btn.btn-primary.btn-xl.btn-block', { type: 'submit', id: 'submit' }, 'Je m’inscris'));
    queueMicrotask(syncSubmit);
    return h('form.card.form-card', { novalidate: true, onsubmit: onSubmit, 'aria-label': 'Inscription' }, children);
  }

  function canSubmit() {
    const f = state.form;
    return !state.submitting && !!f.method && !!f.name.trim() && f.phone.replace(/\D/g, '').length >= 8;
  }
  function syncSubmit() {
    const b = document.getElementById('submit');
    if (b) b.disabled = !canSubmit();
  }
  function clearError() {
    if (!state.error) return;
    state.error = null;
    state.errorField = null;
    document.getElementById('form-error')?.replaceChildren();
    document.getElementById('phone')?.classList.remove('invalid');
  }

  /** Confirmation (après inscription, ou retrouvée avec prénom + numéro). */
  function confirmationView(v, c) {
    const m = v.match;
    const isCard = c.payment_method === 'card';
    const own = !c.for_other;
    const position = v.players.indexOf(c.first_name) + 1;

    const payBlock = isCard
      ? h('div.card.pay-step', [
          h('p', 'Règle maintenant ta place pour confirmer ton paiement.'),
          c.payment_link
            ? h('a.btn.btn-primary.btn-xl.btn-block.pay-cta', { href: c.payment_link, target: '_blank', rel: 'noopener noreferrer' },
                [icon('card'), `Payer par carte · ${F.price(c.price_cents)}`])
            : h('div.alert.warn', { role: 'note' }, [h('span.ico', 'ℹ️'), h('span', 'Le paiement par carte n’est pas encore disponible pour ce tarif. Merci de payer en espèces ou de contacter l’organisateur.')]),
        ])
      : h('div.alert.warn', { role: 'note' }, [
          h('span.ico', '⚠️'),
          h('span', 'Le règlement doit être effectué avant le début du match. Merci d’arriver au moins 5 minutes en avance afin de régler ta place avant de jouer.'),
        ]);

    return h('div.stack', [
      state.notice ? h('div.alert.ok', { role: 'status' }, [h('span.ico', '✅'), h('span', state.notice)]) : null,
      h('section.card.confirm-hero', [
        h('div.check-badge', { html: ICONS.check }),
        h('h2', 'Ton inscription est enregistrée ✅'),
        h('p', own
          ? (position > 0 ? `${c.first_name}, tu es le joueur n°${position} sur ${m.capacity}.` : `À vendredi ${c.first_name} !`)
          : `${c.first_name} est inscrit${position > 0 ? ` (n°${position} sur ${m.capacity})` : ''}.`),
      ]),
      c.loyalty_upgrade ? h('section.card.congrats', [
        h('p.congrats-title', 'Félicitations 🎉'),
        h('p', 'Tu bénéficies maintenant du tarif abonné.'),
        h('p', ['Ton match est à ', h('b', F.price(c.price_cents)), '.']),
      ]) : null,
      h('section.card.amount', [
        h('span.amount-label', isCard ? 'Montant à régler' : 'À régler en espèces'),
        h('span.amount-value.num', F.price(c.price_cents)),
        h('span.amount-tier', c.subscriber ? 'Tarif abonné' : 'Tarif normal'),
      ]),
      payBlock,
      h('section.card.tight', [
        h('dl.recap', [
          h('div', [h('dt', 'Match'), h('dd', F.dayLong(m.date))]),
          h('div', [h('dt', 'Heure'), h('dd.num', F.time(m.time))]),
          h('div', [h('dt', 'Lieu'), h('dd', m.location)]),
          h('div', [h('dt', 'Paiement'), h('dd', isCard ? '💳 Carte' : '💶 Espèces')]),
        ]),
      ]),
      v.remaining > 0 && LINK_TOKEN
        ? h('button.btn.btn-ghost.btn-block', { type: 'button', onclick: () => { state.confirmation = null; state.notice = null; state.forOther = true; resetForm(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
            [icon('plus'), 'Inscrire une autre personne'])
        : null,
      own && LINK_TOKEN
        ? h('button.btn-link.center-link', { type: 'button', onclick: () => { saved.clear(); state.confirmation = null; state.notice = null; resetForm(); render(); } }, 'Ce n’est pas moi')
        : null,
    ]);
  }

  function playersList(v) {
    const mine = state.confirmation && !state.confirmation.for_other ? state.confirmation.first_name : null;
    const items = v.players.map((name, i) => h(`li${name === mine ? '.me' : ''}`, [h('span.n.num', String(i + 1)), h('span', name)]));
    const free = Math.min(v.remaining, 4);
    for (let i = 0; i < free; i++) items.push(h('li.empty', [h('span.n.num', String(v.registered + i + 1)), h('span', 'Place libre')]));
    return h('section.card', { 'aria-label': 'Joueurs inscrits' }, [
      h('div.players-head', [h('h2.section-title', F.plural(v.registered, 'joueur inscrit', 'joueurs inscrits'))]),
      items.length ? h('ol.players', items) : h('p.muted', 'Personne pour l’instant.'),
    ]);
  }

  const footer = () => h('p.footer-note', ['Aucun compte nécessaire · ', h('a', { href: '/admin' }, 'Organisateur')]);
  const brandTop = () => h('div.player-top', [h('span.brand', [h('span.brand-mark', { html: ICONS.ball }), 'Foot du vendredi'])]);

  /* =========================================================
     Rendu principal
     ========================================================= */

  function renderLink() {
    const r = state.res;
    if (r.state === 'invalid') {
      app.replaceChildren(brandTop(), stateCard('🔗', 'Lien non valide', r.message || 'Ce lien d’inscription n’est pas valide.',
        h('p.muted', { style: 'font-size:14px' }, 'Vérifie le lien reçu sur WhatsApp ou demande-le à l’organisateur.')), footer());
      return;
    }
    const v = r.current;
    let main;
    if (state.confirmation) main = confirmationView(v, state.confirmation);
    else if (r.state === 'not_open') main = stateCard('⏳', 'Pas encore ouvert', r.message);
    else if (r.state === 'closed') main = stateCard('🔒', 'Inscriptions fermées', r.message);
    else if (r.state === 'finished') main = stateCard('🏁', 'Match terminé', r.message);
    else if (state.blocked) {
      main = stateCard('⭐', 'Réservé aux prioritaires', state.blocked,
        h('button.btn-link', { type: 'button', style: 'margin-top:10px', onclick: () => { state.blocked = null; render(); } }, 'Modifier ma saisie'));
    } else if (v.remaining === 0) main = stateCard('⚽', 'Foot complet', 'Toutes les places sont prises.', h('p.muted', { style: 'font-size:14px' }, 'Si une place se libère, l’organisateur te préviendra.'));
    else main = form();
    app.replaceChildren(hero(v), main, playersList(v), footer());
  }

  function renderInfo() {
    const v = d();
    if (!v) {
      app.replaceChildren(brandTop(), stateCard('🗓️', 'Pas encore de match', 'Les inscriptions pour le prochain vendredi ne sont pas encore ouvertes. Reviens via le lien WhatsApp de l’organisateur.'), footer());
      return;
    }
    const main = h('section.card.state-card', [
      h('div.big-emoji', '📲'),
      h('h2', 'Inscription par lien'),
      h('p', 'Pour t’inscrire, utilise le lien d’inscription envoyé par l’organisateur sur WhatsApp.'),
    ]);
    app.replaceChildren(hero(v), main, playersList(v), footer());
  }

  function render() {
    if (!state.res) return;
    if (LINK_TOKEN) renderLink();
    else renderInfo();
  }

  /* =========================================================
     Actions
     ========================================================= */

  /** Formulaire vierge, ou pré-rempli avec le prénom/numéro retenus par ce téléphone. */
  function resetForm() {
    const s = !state.forOther ? saved.get() : null;
    state.form = { name: s ? s.first_name : '', phone: s ? s.phone : '', method: '' };
    state.error = null;
    state.errorField = null;
    state.blocked = null;
  }

  function onSubmit(e) {
    e.preventDefault();
    submit();
  }

  async function submit() {
    if (!canSubmit()) return;
    const f = state.form;
    const forOther = state.forOther;
    state.submitting = true;
    const btn = document.getElementById('submit');
    if (btn) { btn.disabled = true; btn.replaceChildren(h('span.spinner'), 'Inscription…'); }

    try {
      const res = await api('POST', `/api/public/matches/${d().match.id}/registrations`, {
        link_token: LINK_TOKEN,
        first_name: f.name.trim(),
        phone: f.phone.trim(),
        payment_method: f.method,
      });
      if (!forOther) saved.set({ first_name: f.name.trim(), phone: f.phone.trim() });
      state.res.current = res.current;
      state.confirmation = { ...res.registration, payment_link: res.payment_link, for_other: forOther };
      state.notice = null;
      state.forOther = false;
      resetForm();
      if (navigator.vibrate) navigator.vibrate(30);
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      handleError(err, forOther);
    } finally {
      state.submitting = false;
      const b = document.getElementById('submit');
      if (b) { b.replaceChildren('Je m’inscris'); syncSubmit(); }
    }
  }

  function handleError(err, forOther) {
    switch (err.error) {
      case 'already_registered':
        // Le serveur renvoie la propre inscription du joueur (il a fourni prénom + numéro)
        if (!forOther) saved.set({ first_name: state.form.name.trim(), phone: state.form.phone.trim() });
        if (err.registration) {
          state.confirmation = { ...err.registration, for_other: forOther };
          state.notice = err.message;
          state.forOther = false;
        } else {
          state.error = err.message;
        }
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'priority_only':
        state.blocked = err.message;
        render();
        break;
      case 'phone_invalid':
      case 'phone_required':
        state.error = err.message;
        state.errorField = 'phone';
        render();
        document.getElementById('phone')?.focus();
        break;
      case 'full':
      case 'not_open':
      case 'closed':
      case 'finished':
      case 'invalid_link':
        load();
        break;
      default:
        state.error = err.message;
        render();
    }
  }

  /** Si ce téléphone a déjà servi, on retrouve la confirmation existante (prénom + numéro vérifiés par le serveur). */
  async function restoreConfirmation() {
    const s = saved.get();
    if (!LINK_TOKEN || !s || !d() || state.res.state === 'invalid') return;
    try {
      const r = await api('POST', `/api/public/matches/${d().match.id}/lookup`, { link_token: LINK_TOKEN, first_name: s.first_name, phone: s.phone });
      if (r.registration) state.confirmation = { ...r.registration, for_other: false };
    } catch { /* ignore */ }
  }

  async function load() {
    try {
      state.res = await api('GET', endpoint);
    } catch (err) {
      if (err.status === 404 && !LINK_TOKEN) { state.res = { current: null }; render(); return; }
      app.replaceChildren(stateCard('📶', 'Oups', err.message, h('button.btn.btn-primary', { style: 'margin-top:18px', onclick: () => location.reload() }, 'Réessayer')));
      return;
    }
    render();
  }

  /** Rafraîchit les places sans perturber la saisie en cours. */
  async function refresh() {
    if (state.submitting || document.querySelector('.form-card input:focus')) return;
    try {
      const res = await api('GET', endpoint);
      if (JSON.stringify(res) === JSON.stringify(state.res)) return;
      state.res = res;
      render();
    } catch { /* on réessaiera */ }
  }

  resetForm();
  load().then(async () => {
    if (state.res && !state.confirmation) {
      await restoreConfirmation();
      if (state.confirmation) render();
    }
    setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 20000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  });
})();
