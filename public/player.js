/* Page joueur.
 *  /i/<jeton>   lien d'inscription (Prioritaires / Ouvert / Invitations)
 *  /  et /m/<id> informations du prochain match (sans inscription)
 * Toutes les règles (phase, lien, statut abonné, tarif, capacité) sont décidées par le serveur.
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

  const state = {
    res: null,             // réponse serveur (link ou info)
    confirmation: null,    // inscription réalisée (réponse du serveur)
    blocked: null,         // message bloquant (ex. réservé aux prioritaires)
    asOther: false,        // inscrire quelqu'un d'autre depuis ce téléphone
    form: { name: '', subscriber: null, code: '', method: '' },
    showCode: false,
    notRecognized: false,
    submitting: false,
    error: null,
  };

  const d = () => state.res && state.res.current;
  const me = () => (state.asOther ? null : state.res && state.res.me);

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

  /** Carte « c'est bien toi » quand le téléphone est reconnu. */
  function identityCard(p, v) {
    let line;
    if (p.subscriber) line = [h('span.tag-prio', 'Prioritaire'), `Tarif abonné : ${F.price(p.price_cents)}`];
    else if (p.loyalty_eligible) line = ['🎉 ', `Tarif abonné débloqué : ${F.price(p.price_cents)}`];
    else line = [`Tarif : ${F.price(p.price_cents ?? v.match.price_cents)}`];
    return h('div.identity', [
      h('div.identity-top', [
        h('div', [h('p.identity-hello', `Salut ${p.first_name} 👋`), h('p.identity-line', line)]),
      ]),
      h('div.identity-actions', [
        h('button.btn-link', { type: 'button', onclick: forgetMe }, 'Ce n’est pas moi'),
        h('button.btn-link', { type: 'button', onclick: () => { state.asOther = true; resetForm(); render(); } }, 'Inscrire quelqu’un d’autre'),
      ]),
    ]);
  }

  function choiceButtons(name, current, options, onPick) {
    return h('div.pay-choice', options.map(([value, emoji, title, sub]) => h('div.pay-option', [
      h('input', { type: 'radio', name, id: `${name}-${value}`, value: String(value), checked: current === value,
        onchange: () => onPick(value) }),
      h('label', { for: `${name}-${value}` }, [emoji ? h('span.emoji', { 'aria-hidden': 'true' }, emoji) : null, h('span.t', title), sub ? h('span.s', sub) : null]),
    ])));
  }

  function form(v) {
    const p = me();
    const f = state.form;
    const m = v.match;
    const children = [];

    if (state.res.priority_only && !p) {
      children.push(h('div.alert.info', [h('span.ico', '⭐'), h('span', 'Inscriptions réservées aux joueurs prioritaires (abonnés) pour le moment.')]));
    }
    if (state.asOther) {
      children.push(h('div.row.between', [
        h('p.label', 'Inscrire un autre joueur'),
        state.res.me ? h('button.btn-link', { type: 'button', onclick: () => { state.asOther = false; resetForm(); render(); } }, 'Annuler') : null,
      ]));
    }

    if (p) {
      children.push(identityCard(p, v));
    } else {
      const nameInput = h('input.input', {
        id: 'first-name', name: 'first_name', type: 'text', required: true, maxlength: 30,
        autocomplete: 'given-name', autocapitalize: 'words', enterkeyhint: 'next',
        placeholder: 'Ex. Thomas', value: f.name,
        oninput: (e) => { f.name = e.target.value; state.notRecognized = false; clearError(); syncSubmit(); },
      });
      nameInput.spellcheck = false;
      children.push(h('div.field', [h('label.label', { for: 'first-name' }, 'Prénom'), nameInput]));

      children.push(h('fieldset.field.plain', [
        h('legend.label', 'Es-tu abonné ?'),
        h('div.sub-choice', choiceButtons('subscriber', f.subscriber, [[true, '', 'Oui, je suis abonné'], [false, '', 'Non']], (val) => {
          f.subscriber = val;
          state.showCode = val === true || state.showCode;
          state.notRecognized = false;
          state.error = null;
          render();
          if (val === true) setTimeout(() => document.getElementById('player-code')?.focus(), 30);
        })),
        f.subscriber === true
          ? h('p.hint', `Tarif abonné (${F.price(m.subscriber_price_cents)}) après vérification de ta fiche.`)
          : f.subscriber === false ? h('p.hint', `Tarif : ${F.price(m.price_cents)}`) : null,
      ]));

      if (state.showCode) {
        const codeInput = h('input.input.code-input', {
          id: 'player-code', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 4, autocomplete: 'one-time-code',
          placeholder: '• • • •', value: f.code,
          oninput: (e) => { f.code = e.target.value.replace(/\D/g, '').slice(0, 4); e.target.value = f.code; clearError(); syncSubmit(); },
        });
        children.push(h('div.field', [
          h('label.label', { for: 'player-code' }, 'Ton code joueur'),
          codeInput,
          h('p.hint', 'Code à 4 chiffres affiché après ta première inscription (ou demande-le à l’organisateur). Une seule fois par téléphone.'),
        ]));
      }
    }

    children.push(h('fieldset.field.plain', [
      h('legend.label', 'Mode de paiement'),
      choiceButtons('payment_method', f.method, [['card', '💳', 'Payer par carte', 'Lien de paiement'], ['cash', '💶', 'Payer en espèces', 'Sur place']], (val) => {
        f.method = val; clearError(); syncSubmit();
      }),
    ]));

    const errorSlot = h('div.error-slot', { id: 'form-error' });
    children.push(errorSlot);
    if (state.notRecognized) {
      errorSlot.append(h('div.alert.warn', { role: 'alert' }, [
        h('span.ico', '⚠️'),
        h('div', [
          h('p', 'Ton statut abonné n’a pas été reconnu. Tu peux t’inscrire au tarif normal ou contacter l’organisateur.'),
          h('button.btn.btn-sm.btn-ghost', { type: 'button', style: 'margin-top:10px', onclick: registerNormal }, `M’inscrire au tarif normal (${F.price(m.price_cents)})`),
        ]),
      ]));
    } else if (state.error) {
      errorSlot.append(h('div.alert.error', { role: 'alert' }, [h('span.ico', '⚠️'), h('span', state.error)]));
    }

    children.push(h('button.btn.btn-primary.btn-xl.btn-block', { type: 'submit', id: 'submit' }, 'Je m’inscris'));
    queueMicrotask(syncSubmit);
    return h('form.card.form-card', { novalidate: true, onsubmit: onSubmit, 'aria-label': 'Inscription' }, children);
  }

  function canSubmit() {
    const f = state.form;
    if (state.submitting || !f.method) return false;
    if (me()) return true;
    if (!f.name.trim() || f.subscriber === null) return false;
    if (f.subscriber === true && f.code.length !== 4) return false;
    return true;
  }
  function syncSubmit() {
    const b = document.getElementById('submit');
    if (b) b.disabled = !canSubmit();
  }
  function clearError() {
    state.error = null;
    const slot = document.getElementById('form-error');
    if (slot && !state.notRecognized) slot.replaceChildren();
  }

  /** Confirmation (après inscription, ou retrouvée grâce au téléphone reconnu). */
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
            : h('div.alert.info', [h('span.ico', 'ℹ️'), h('span', 'Le lien de paiement n’est pas encore disponible. L’organisateur te l’enverra sur WhatsApp.')]),
        ])
      : h('div.alert.warn', { role: 'note' }, [
          h('span.ico', '⚠️'),
          h('span', 'Le règlement doit être effectué avant le début du match. Merci d’arriver au moins 5 minutes en avance afin de régler ta place avant de jouer.'),
        ]);

    return h('div.stack', [
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
        h('p', [`Ton match est à `, h('b', F.price(c.price_cents)), '.']),
      ]) : null,
      h('section.card.amount', [
        h('span.amount-label', 'Montant à régler'),
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
      c.player_code ? h('section.card.code-card', [
        h('div', [
          h('p.label', own ? 'Ton code joueur' : `Code joueur de ${c.first_name}`),
          h('p.hint', own ? 'Garde-le : il te permet d’être reconnu si tu changes de téléphone.' : 'À lui transmettre : il lui servira pour ses prochaines inscriptions.'),
        ]),
        h('span.code-value.num', c.player_code),
      ]) : null,
      v.remaining > 0 && LINK_TOKEN
        ? h('button.btn.btn-ghost.btn-block', { type: 'button', onclick: () => { state.confirmation = null; state.asOther = true; resetForm(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
            [icon('plus'), 'Inscrire un autre joueur'])
        : null,
    ]);
  }

  function playersList(v) {
    const mine = me() ? me().first_name : null;
    const items = v.players.map((name, i) => h(`li${name === mine ? '.me' : ''}`, [h('span.n.num', String(i + 1)), h('span', name)]));
    const free = Math.min(v.remaining, 4);
    for (let i = 0; i < free; i++) items.push(h('li.empty', [h('span.n.num', String(v.registered + i + 1)), h('span', 'Place libre')]));
    return h('section.card', { 'aria-label': 'Joueurs inscrits' }, [
      h('div.players-head', [h('h2.section-title', F.plural(v.registered, 'joueur inscrit', 'joueurs inscrits'))]),
      items.length ? h('ol.players', items) : h('p.muted', 'Personne pour l’instant.'),
    ]);
  }

  const footer = () => h('p.footer-note', ['Aucun compte nécessaire · ', h('a', { href: '/admin' }, 'Organisateur')]);

  /* =========================================================
     Rendu principal
     ========================================================= */

  function registrationFromMe(p) {
    const r = p.registration;
    return {
      first_name: p.first_name, payment_method: r.payment_method, price_cents: r.price_cents,
      subscriber: r.tier !== 'standard', loyalty_upgrade: r.tier === 'loyalty_upgrade',
      player_code: p.code, payment_link: r.payment_link,
    };
  }

  function renderLink() {
    const r = state.res;
    if (r.state === 'invalid') {
      app.replaceChildren(brandTop(), stateCard('🔗', 'Lien non valide', r.message || 'Ce lien d’inscription n’est pas valide.',
        h('p.muted', { style: 'font-size:14px' }, 'Vérifie le lien reçu sur WhatsApp ou demande-le à l’organisateur.')), footer());
      return;
    }
    const v = r.current;
    let main;
    const p = me();
    if (state.confirmation) main = confirmationView(v, state.confirmation);
    else if (p && p.registration) main = confirmationView(v, registrationFromMe(p));
    else if (r.state === 'not_open') main = stateCard('⏳', 'Pas encore ouvert', r.message);
    else if (r.state === 'closed') main = stateCard('🔒', 'Inscriptions fermées', r.message);
    else if (r.state === 'finished') main = stateCard('🏁', 'Match terminé', r.message);
    else if (state.blocked || (r.priority_only && p && !p.priority)) {
      main = stateCard('⭐', 'Réservé aux prioritaires', state.blocked || 'Les inscriptions sont actuellement réservées aux joueurs prioritaires. Tu pourras revenir lorsque les inscriptions seront ouvertes à tous.',
        h('button.btn-link', { type: 'button', style: 'margin-top:10px', onclick: () => { state.blocked = null; resetForm(); if (p) forgetMe(); else render(); } }, p ? 'Ce n’est pas moi' : 'Modifier ma saisie'));
    } else if (v.remaining === 0) main = stateCard('⚽', 'Foot complet', 'Toutes les places sont prises.', h('p.muted', { style: 'font-size:14px' }, 'Si une place se libère, l’organisateur te préviendra.'));
    else main = form(v);
    app.replaceChildren(hero(v), main, playersList(v), footer());
  }

  function renderInfo() {
    const v = d();
    if (!v) {
      app.replaceChildren(brandTop(), stateCard('🗓️', 'Pas encore de match', 'Les inscriptions pour le prochain vendredi ne sont pas encore ouvertes. Reviens via le lien WhatsApp de l’organisateur.'), footer());
      return;
    }
    const p = state.res.me;
    const main = p && p.registration
      ? confirmationView(v, registrationFromMe(p))
      : h('section.card.state-card', [
          h('div.big-emoji', '📲'),
          h('h2', 'Inscription par lien'),
          h('p', 'Pour t’inscrire, utilise le lien d’inscription envoyé par l’organisateur sur WhatsApp.'),
        ]);
    app.replaceChildren(hero(v), main, playersList(v), footer());
  }

  function brandTop() {
    return h('div.player-top', [h('span.brand', [h('span.brand-mark', { html: ICONS.ball }), 'Foot du vendredi'])]);
  }

  function render() {
    if (!state.res) return;
    if (LINK_TOKEN) renderLink();
    else renderInfo();
  }

  /* =========================================================
     Actions
     ========================================================= */

  function resetForm() {
    state.form = { name: '', subscriber: null, code: '', method: '' };
    state.showCode = false;
    state.notRecognized = false;
    state.error = null;
    state.blocked = null;
  }

  async function forgetMe() {
    try { await api('POST', '/api/public/forget', {}); } catch { /* ignore */ }
    state.asOther = false;
    resetForm();
    await load();
  }

  function registerNormal() {
    state.form.subscriber = false;
    state.form.code = '';
    state.showCode = false;
    state.notRecognized = false;
    render();
    submit();
  }

  function onSubmit(e) {
    e.preventDefault();
    submit();
  }

  async function submit() {
    if (!canSubmit()) return;
    const f = state.form;
    const p = me();
    state.submitting = true;
    const btn = document.getElementById('submit');
    if (btn) { btn.disabled = true; btn.replaceChildren(h('span.spinner'), 'Inscription…'); }

    try {
      const res = await api('POST', `/api/public/matches/${d().match.id}/registrations`, {
        link_token: LINK_TOKEN,
        payment_method: f.method,
        ...(p ? {} : { first_name: f.name.trim(), claims_subscriber: f.subscriber === true, player_code: f.code || undefined }),
        as_other: state.asOther || undefined,
      });
      state.res.current = res.current;
      state.confirmation = { ...res.registration, payment_link: res.payment_link, for_other: state.asOther };
      const wasOther = state.asOther;
      resetForm();
      if (!wasOther) {
        // Le téléphone connaît maintenant son joueur : on recharge « me » sans perdre la confirmation
        try { const fresh = await api('GET', endpoint); state.res = fresh; } catch { /* ignore */ }
      }
      state.asOther = false;
      if (navigator.vibrate) navigator.vibrate(30);
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      handleError(err);
    } finally {
      state.submitting = false;
      const b = document.getElementById('submit');
      if (b) { b.replaceChildren('Je m’inscris'); syncSubmit(); }
    }
  }

  function handleError(err) {
    switch (err.error) {
      case 'priority_only':
        state.blocked = err.message;
        render();
        break;
      case 'subscriber_not_recognized':
        state.notRecognized = true;
        render();
        break;
      case 'code_required':
      case 'name_taken':
        state.showCode = true;
        state.error = err.message;
        render();
        setTimeout(() => document.getElementById(err.error === 'name_taken' && !state.form.code ? 'first-name' : 'player-code')?.focus(), 30);
        break;
      case 'bad_code':
        state.error = err.message;
        render();
        break;
      case 'already_registered':
        if (state.asOther) { state.error = 'Ce joueur est déjà inscrit à ce match ✅'; render(); } else load();
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

  async function load() {
    try {
      state.res = await api('GET', endpoint);
    } catch (err) {
      if (err.status === 404 && !LINK_TOKEN) { state.res = { current: null, me: null }; render(); return; }
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
      const before = JSON.stringify(state.res);
      if (JSON.stringify(res) === before) return;
      state.res = res;
      render();
    } catch { /* on réessaiera */ }
  }

  load().then(() => {
    setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 20000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  });
})();
