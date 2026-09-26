/* Espace administrateur — mini application à routes par ancre (#/…). */
(function () {
  'use strict';
  const { F, h, icon, ICONS, api, toast, copyText, PHASES } = window.FDV;
  const root = document.getElementById('root');

  const METHOD_LABEL = { card: '💳 Carte', cash: '💶 Espèces' };
  const STATUS_LABEL = { paid: 'Payé', to_pay: 'À payer', cash_due: 'À encaisser' };
  const ATT_LABEL = { present: 'Présent', absent: 'Absent', unknown: 'Non renseigné' };
  const SUB_LABEL = { none: 'Non abonné', annual: 'Abonné annuel', loyalty: 'Abonné fidélité' };
  const LINK_LABEL = { priority: 'Prioritaires', open: 'Ouvert', invite: 'Invitations' };
  const LINK_SUB = { priority: 'Abonnés uniquement pendant la phase Prioritaires', open: 'Tout le monde, dès la phase Ouvert', invite: 'Au cas par cas, dès la phase Invitations' };

  const ui = {
    view: null,        // dernière vue de match affichée (pour rafraîchissement)
    filter: 'all',
    playerFilter: 'all',
    playerSearch: '',
    refreshTimer: null,
  };

  const generalUrl = () => `${location.origin}/`;
  const linkUrl = (token) => `${location.origin}/i/${token}`;
  const euros = (cents) => F.price(cents);
  const toCents = (v) => Math.round(parseFloat(String(v).replace(',', '.')) * 100);

  /* =========================================================
     Coquille : barre du haut + navigation
     ========================================================= */

  function shell(active, content) {
    const nav = [
      ['match', '#/', 'Match', 'ball'],
      ['players', '#/players', 'Joueurs', 'users'],
      ['history', '#/history', 'Historique', 'history'],
      ['settings', '#/settings', 'Réglages', 'settings'],
    ];
    const link = ([k, href, label, ic]) => h('a', { href, 'aria-current': active === k ? 'page' : false }, [icon(ic), h('span', label)]);
    return h('div.admin-shell', [
      h('header.topbar', h('div.topbar-in', [
        h('a.brand', { href: '#/' }, [h('span.brand-mark', { html: ICONS.ball }), h('span', ['Foot du vendredi', h('small', ' ADMIN')])]),
        h('nav.topnav', { 'aria-label': 'Navigation' }, nav.map(link)),
      ])),
      h('main.wrap.stack', content),
      h('nav.bottomnav', { 'aria-label': 'Navigation' }, nav.map(link)),
    ]);
  }

  function mount(active, content) {
    root.replaceChildren(shell(active, content));
  }

  function loading(active) {
    mount(active, [h('div.skeleton', { style: 'height:120px' }), h('div.skeleton', { style: 'height:230px' }), h('div.skeleton', { style: 'height:320px' })]);
  }

  function errorView(active, err) {
    mount(active, [h('div.card.empty-state', [h('div.big-emoji', '⚠️'), h('h2', 'Erreur'), h('p', err.message || 'Une erreur est survenue.'),
      h('button.btn.btn-primary', { onclick: () => route() }, 'Réessayer')])]);
  }

  const alertBox = (kind, emoji, content) => h(`div.alert.${kind}`, [h('span.ico', emoji), h('span', content)]);
  const errorBox = (msg) => alertBox('error', '⚠️', msg);

  /* =========================================================
     Connexion
     ========================================================= */

  function loginView() {
    let pending = false;
    const input = h('input.input', { type: 'password', id: 'pw', autocomplete: 'current-password', placeholder: 'Mot de passe', required: true, autofocus: true });
    const err = h('div');
    const btn = h('button.btn.btn-primary.btn-block.btn-xl', { type: 'submit' }, 'Se connecter');
    const form = h('form.card', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (pending) return;
        pending = true; btn.disabled = true; err.replaceChildren();
        try {
          await api('POST', '/api/admin/login', { password: input.value });
          route();
        } catch (e2) {
          err.replaceChildren(errorBox(e2.message));
          input.select();
        } finally { pending = false; btn.disabled = false; }
      },
    }, [
      h('div.lock', { html: ICONS.lock }),
      h('div', [h('p.eyebrow', 'Foot du vendredi'), h('h1', 'Espace organisateur')]),
      h('div.field', [h('label.label', { for: 'pw' }, 'Mot de passe'), input]),
      err,
      btn,
      h('a.muted', { href: '/', style: 'text-align:center;font-size:14px' }, '← Page du match'),
    ]);
    root.replaceChildren(h('div.login', form));
    setTimeout(() => input.focus(), 50);
  }

  /* =========================================================
     Dialogues
     ========================================================= */

  function openSheet(build) {
    const dlg = h('dialog.sheet');
    const close = () => { dlg.close(); };
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // clic sur le fond
    dlg.append(h('div.sheet-in', [h('div.sheet-grab'), ...[].concat(build(close))]));
    document.body.append(dlg);
    dlg.showModal();
    return dlg;
  }

  function confirmSheet({ title, message, confirmLabel, danger = true }) {
    return new Promise((resolve) => {
      let result = false;
      const dlg = openSheet((close) => [
        h('h2.sheet-title', title),
        h('p', { style: 'color:var(--text-2)' }, message),
        h('div.sheet-actions.two', [
          h('button.btn.btn-ghost', { type: 'button', onclick: close }, 'Annuler'),
          h(`button.btn${danger ? '.btn-danger' : '.btn-primary'}`, { type: 'button', onclick: () => { result = true; close(); } }, confirmLabel),
        ]),
      ]);
      dlg.addEventListener('close', () => resolve(result));
    });
  }

  function methodChoice(name, current) {
    const opt = (value, emoji, label) => h('div.pay-option', [
      h('input', { type: 'radio', name, id: `${name}-${value}`, value, checked: current === value }),
      h('label', { for: `${name}-${value}` }, [h('span.emoji', emoji), h('span.t', label)]),
    ]);
    return h('div.pay-choice.compact', [opt('card', '💳', 'Carte'), opt('cash', '💶', 'Espèces')]);
  }

  function switchRow(id, label, checked) {
    return h('label.toggle-row', { for: id }, [h('span', label), h('span.switch', [h('input', { type: 'checkbox', id, checked }), h('span')])]);
  }

  /** Petit groupe de boutons à choix unique (segmented control). */
  function segmented(options, current, onPick, { cls = '' } = {}) {
    const wrap = h(`div.seg${cls}`, { role: 'group' });
    const draw = (value) => {
      wrap.replaceChildren(...options.map(([v, label]) => h('button', {
        type: 'button', 'aria-pressed': String(value === v), 'data-v': v,
        onclick: () => { draw(v); onPick(v); },
      }, label)));
    };
    draw(current);
    return wrap;
  }

  function withBusy(btn, fn) {
    return async (...args) => {
      if (btn.disabled) return;
      const label = [...btn.childNodes];
      btn.disabled = true;
      btn.replaceChildren(h('span.spinner'));
      try { await fn(...args); } finally { btn.disabled = false; btn.replaceChildren(...label); }
    };
  }

  function statusBadge(sub) {
    return h(`span.badge.sub-${sub}`, SUB_LABEL[sub]);
  }

  /** Numéro affiché (admin uniquement) ou badge « Numéro à renseigner ». */
  function phoneBadge(p) {
    return p.missing_phone ? h('span.badge.no-phone', 'Numéro à renseigner') : h('span.phone.num', p.phone_display);
  }

  /** Recherche par prénom ou par chiffres du numéro (06 12…, 612…, +33…). */
  function matchesQuery(p, q) {
    if (!q) return true;
    if (p.first_name.toLowerCase().includes(q.toLowerCase())) return true;
    const digits = q.replace(/\D/g, '');
    if (digits.length < 2 || !p.phone) return false;
    const national = p.phone.startsWith('+33') ? `0${p.phone.slice(3)}` : p.phone.replace('+', '');
    return national.includes(digits) || p.phone.replace('+', '').includes(digits);
  }

  /* ---------- Ajouter un joueur au match (fiche existante ou nouvelle) ---------- */
  function addPlayerSheet(v, onDone) {
    const inMatch = new Set(v.registrations.map((r) => r.player_id));
    openSheet((close) => {
      let players = [];
      let selected = null; // { id, first_name } ou { new: 'Nom' }
      const search = h('input.input', { id: 'add-name', placeholder: 'Prénom ou numéro', maxlength: 30, autocapitalize: 'words', autocomplete: 'off' });
      const list = h('div.pick-list');
      const chosen = h('div');
      const newPhone = h('input.input', { id: 'add-phone', type: 'tel', inputmode: 'tel', placeholder: '06 12 34 56 78 (conseillé)', maxlength: 20, autocomplete: 'off' });
      const newPhoneField = h('div.field', { hidden: true }, [h('label.label', { for: 'add-phone' }, 'Téléphone du nouveau joueur'), newPhone,
        h('p.hint', 'Sans numéro, la fiche sera « Numéro à renseigner ».')]);
      const err = h('div');
      const submit = h('button.btn.btn-primary.btn-block', { type: 'submit' }, [icon('plus'), 'Ajouter au match']);

      const drawChosen = () => {
        chosen.replaceChildren(selected
          ? alertBox('ok', selected.id ? '👤' : '✨', selected.id
            ? `Fiche existante : ${selected.first_name} — ${selected.label} · ${euros(selected.price_cents)}`
            : `Nouvelle fiche : « ${selected.new} » (non abonné)`)
          : h('p.hint', 'Recherche par prénom ou par numéro. Choisis une fiche existante (conseillé) ou crée un nouveau joueur.'));
        newPhoneField.hidden = !(selected && !selected.id);
      };
      const drawList = () => {
        const q = search.value.trim().toLowerCase();
        const matches = players.filter((p) => matchesQuery(p, search.value.trim())).slice(0, 8);
        const items = matches.map((p) => h('button.pick', {
          type: 'button', disabled: inMatch.has(p.id),
          onclick: () => { selected = p; drawChosen(); },
        }, [h('span.pick-name', [p.first_name, h('small.pick-phone', p.missing_phone ? ' · sans numéro' : ` · ${p.phone_display}`)]), h('span.pick-meta', inMatch.has(p.id) ? 'déjà inscrit' : `${p.label} · ${euros(p.price_cents)}`)]));
        if (q && /\p{L}/u.test(q)) items.push(h('button.pick.pick-new', { type: 'button', onclick: () => { selected = { new: search.value.trim() }; drawChosen(); } },
          [h('span.pick-name', ['+ Nouveau joueur « ', search.value.trim(), ' »'])]));
        list.replaceChildren(...items);
      };
      search.addEventListener('input', () => { selected = null; drawChosen(); drawList(); });
      api('GET', '/api/admin/players').then((r) => { players = r.players; drawList(); }).catch(() => {});
      drawChosen();

      const form = h('form.stack', {
        onsubmit: async (e) => {
          e.preventDefault();
          const method = form.querySelector('input[name=add-m]:checked')?.value;
          if (!selected) return err.replaceChildren(errorBox('Choisis un joueur dans la liste.'));
          if (!method) return err.replaceChildren(errorBox('Choisis le mode de paiement.'));
          const paid = form.querySelector('#add-paid').checked;
          await withBusy(submit, async () => {
            try {
              const nv = await api('POST', `/api/admin/matches/${v.match.id}/registrations`, {
                ...(selected.id ? { player_id: selected.id } : { first_name: selected.new, phone: newPhone.value.trim() || undefined }),
                payment_method: method, ...(paid ? { payment_status: 'paid' } : {}),
              });
              close(); onDone(nv); toast('Joueur ajouté ✅');
            } catch (e2) { err.replaceChildren(errorBox(e2.message)); }
          })();
        },
      }, [
        h('div.field', [h('label.label', { for: 'add-name' }, 'Joueur'), search, list, chosen]),
        newPhoneField,
        h('div.field', [h('span.label', 'Mode de paiement'), methodChoice('add-m', '')]),
        switchRow('add-paid', 'Déjà payé', false),
        h('p.hint', 'Le tarif est calculé automatiquement selon la fiche du joueur.'),
        err,
        submit,
      ]);
      setTimeout(() => search.focus(), 80);
      return [h('h2.sheet-title', 'Ajouter un joueur'), form];
    });
  }

  /* ---------- Modifier une inscription ---------- */
  function editRegistrationSheet(reg, onDone) {
    openSheet((close) => {
      const price = h('input.input', { id: 'ed-price', type: 'number', min: 0, step: 0.5, inputmode: 'decimal', value: String(reg.price_cents / 100) });
      let attendance = reg.attendance;
      const err = h('div');
      const save = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Enregistrer');
      const del = h('button.btn.btn-danger.btn-block', { type: 'button' }, [icon('trash'), 'Supprimer l’inscription']);

      del.addEventListener('click', async () => {
        close();
        const ok = await confirmSheet({
          title: 'Supprimer ?',
          message: `L’inscription de ${reg.first_name} sera supprimée et sa place libérée. Cette action est définitive.`,
          confirmLabel: 'Supprimer',
        });
        if (!ok) return;
        try {
          const nv = await api('DELETE', `/api/admin/registrations/${reg.id}`);
          onDone(nv); toast('Inscription supprimée');
        } catch (e) { toast(e.message, 'error'); }
      });

      const form = h('form.stack', {
        onsubmit: async (e) => {
          e.preventDefault();
          const method = form.querySelector('input[name=ed-m]:checked').value;
          const paid = form.querySelector('#ed-paid').checked;
          const cents = toCents(price.value);
          if (!Number.isFinite(cents) || cents < 0) return err.replaceChildren(errorBox('Tarif invalide.'));
          await withBusy(save, async () => {
            try {
              const nv = await api('PATCH', `/api/admin/registrations/${reg.id}`, {
                payment_method: method, payment_status: paid ? 'paid' : (method === 'cash' ? 'cash_due' : 'to_pay'),
                price_cents: cents, attendance,
              });
              close(); onDone(nv); toast('Modifié ✅');
            } catch (e2) { err.replaceChildren(errorBox(e2.message)); }
          })();
        },
      }, [
        h('div.row.between', [
          h('div', [h('p', { style: 'font-weight:800;font-size:20px' }, reg.first_name), h('p.hint', `${reg.tier_label} · inscrit ${F.stamp(reg.created_at)}${reg.source === 'admin' ? ' · ajouté par toi' : ''}`)]),
          reg.player_id ? h('a.btn.btn-ghost.btn-sm', { href: `#/player/${reg.player_id}`, onclick: () => close() }, [icon('users'), 'Fiche']) : null,
        ]),
        h('div.field', [h('span.label', 'Présence'), segmented([['present', 'Présent'], ['absent', 'Absent'], ['unknown', 'Non renseigné']], attendance, (v2) => { attendance = v2; }, { cls: '.seg-att' })]),
        h('div.field', [h('span.label', 'Mode de paiement'), methodChoice('ed-m', reg.payment_method)]),
        switchRow('ed-paid', 'Payé', reg.payment_status === 'paid'),
        h('div.field', [h('label.label', { for: 'ed-price' }, 'Tarif de ce match'), h('div.input-group', [price, h('span.suffix', '€')]),
          h('p.hint', 'Tarif enregistré au moment de l’inscription. À modifier seulement pour corriger une erreur.')]),
        err,
        h('div.sheet-actions', [save, del]),
      ]);
      return [h('h2.sheet-title', 'Inscription'), form];
    });
  }

  /* =========================================================
     Panneau d'un match (tableau de bord / détail)
     ========================================================= */

  function statCards(v) {
    const s = v.stats; const m = v.match;
    return h('section.stats', { 'aria-label': 'Chiffres clés' }, [
      h('div.stat.accent', [h('div.v.num', [String(s.registered), h('small', ` / ${m.capacity}`)]), h('div.l', 'joueurs'), s.subscribers ? h('div.d', `dont ${s.subscribers} abonné${s.subscribers > 1 ? 's' : ''}`) : null]),
      h('div.stat', [h('div.v.num', String(s.remaining)), h('div.l', s.remaining === 0 ? 'Complet ⚽' : s.remaining > 1 ? 'places restantes' : 'place restante')]),
      h('div.stat.ok', [h('div.v.num', String(s.paid)), h('div.l', s.paid > 1 ? 'payés' : 'payé')]),
      h(`div.stat${s.unpaid ? '.warn' : ''}`, [
        h('div.v.num', String(s.unpaid)), h('div.l', 'à encaisser'),
        s.unpaid ? h('div.d', [s.cash_due ? `${s.cash_due} espèces` : null, s.cash_due && s.to_pay ? ' · ' : null, s.to_pay ? `${s.to_pay} carte` : null]) : null,
      ]),
    ]);
  }

  function revenueCard(v) {
    const s = v.stats;
    const pct = s.revenue_expected_cents ? Math.round((s.revenue_collected_cents / s.revenue_expected_cents) * 100) : 0;
    return h('section.card.tight', [
      h('div.revenue', [
        h('div', [h('div.label', v.match.is_past ? 'Recette du match' : 'Encaissé'), h('div.big.num', [euros(s.revenue_collected_cents), h('small', ` / ${euros(s.revenue_expected_cents)}`)])]),
        h('div.muted.num', { style: 'text-align:right;font-size:14px' }, [
          `${euros(v.match.price_cents)} · ${euros(v.match.subscriber_price_cents)} abonnés`, h('br'),
          `${s.card} carte · ${s.cash} espèces`,
          v.match.is_past ? [h('br'), `${s.present} présents · ${s.absent} absents`] : null,
        ]),
      ]),
      h('div.bar.slim', h('span', { style: `width:${pct}%` })),
    ]);
  }

  function copyButton(label, url, { primary = false, sub = null, active = null } = {}) {
    const btn = h(`button.btn.share-btn${primary ? '.btn-primary' : ''}`, { type: 'button' }, [
      icon('copy'),
      h('span.share-txt', [h('span.share-l', label), sub ? h('span.share-s', sub) : null]),
      active === null ? null : h(`span.share-state.${active ? 'on' : 'off'}`, active ? 'Actif' : 'Pas encore'),
    ]);
    const original = [...btn.childNodes];
    btn.addEventListener('click', async () => {
      const ok = await copyText(url);
      if (ok) {
        btn.classList.add('copied');
        btn.replaceChildren(icon('check'), h('span.share-txt', h('span.share-l', 'Lien copié ✅')));
        toast('Lien copié ✅');
        setTimeout(() => { btn.classList.remove('copied'); btn.replaceChildren(...original); }, 2000);
      } else toast('Copie impossible', 'error');
    });
    return btn;
  }

  function shareCard(v, onChange) {
    const links = Object.fromEntries(v.links.map((l) => [l.level, l]));
    const whatsappText = `⚽ Foot du vendredi — ${F.dayLong(v.match.date)} à ${F.time(v.match.time)}, ${v.match.location}. Inscris-toi ici :`;
    const regen = h('button.btn-link', { type: 'button', style: 'font-size:13px' }, 'Régénérer les liens');
    regen.addEventListener('click', async () => {
      const ok = await confirmSheet({ title: 'Nouveaux liens ?', message: 'Les trois anciens liens de ce match cesseront immédiatement de fonctionner. À utiliser si un lien a circulé par erreur.', confirmLabel: 'Régénérer' });
      if (!ok) return;
      try { onChange(await api('POST', `/api/admin/matches/${v.match.id}/links/regenerate`, {})); toast('Nouveaux liens générés'); }
      catch (e) { toast(e.message, 'error'); }
    });
    return h('section.card.share-card', [
      h('div.row.between', [h('h2.section-title', 'Partager le foot'), regen]),
      ...['priority', 'open', 'invite'].map((lvl) => copyButton(`Copier lien ${LINK_LABEL[lvl]}`, linkUrl(links[lvl].token), {
        primary: links[lvl].active && (lvl === v.match.status || (lvl === 'invite' && v.match.status === 'invite')),
        sub: LINK_SUB[lvl],
        active: links[lvl].active,
      })),
      h('p.hint', ['Colle le lien dans WhatsApp. ', h('a', { href: `https://wa.me/?text=${encodeURIComponent(whatsappText)}`, target: '_blank', rel: 'noopener' }, 'Ouvrir WhatsApp')]),
      h('div.share-general', [
        h('span.hint', 'Lien général (infos du match, sans inscription) :'),
        copyButton('Copier le lien général', generalUrl()),
      ]),
    ]);
  }

  function phaseCard(v, onChange) {
    const m = v.match;
    const seg = (value) => h('button', {
      type: 'button', 'data-value': value, 'aria-pressed': String(m.status === value),
      onclick: async () => {
        if (m.status === value) return;
        try {
          const nv = await api('PATCH', `/api/admin/matches/${m.id}`, { status: value });
          onChange(nv); toast(`Phase : ${PHASES[value].label}`);
        } catch (e) { toast(e.message, 'error'); }
      },
    }, [PHASES[value].label, h('small', PHASES[value].sub)]);

    const active = v.links.filter((l) => l.active).map((l) => LINK_LABEL[l.level]);
    return h('section.card.stack', [
      h('div', [
        h('p.status-line', ['Phase actuelle : ', h(`b.${m.status}`, PHASES[m.status].label)]),
        h('p.hint', active.length ? `Liens actifs : ${active.join(', ')}${m.status === 'priority' ? ' — réservé aux abonnés' : ''}` : 'Aucun lien actif.'),
      ]),
      m.status === 'draft' ? alertBox('info', '👀', 'Ce match est en brouillon : les joueurs ne le voient pas. Choisis une phase pour le publier.') : null,
      h('div.segments', ['priority', 'open', 'invite', 'closed'].map(seg)),
      h('div.kv', [h('span.k', 'Nombre de places'), capacityStepper(v, onChange)]),
    ]);
  }

  function capacityStepper(v, onChange) {
    const m = v.match;
    const val = h('span.val.num', String(m.capacity));
    let pending = m.capacity;
    let timer;
    const minus = h('button', { type: 'button', 'aria-label': 'Retirer une place', html: ICONS.minus });
    const plus = h('button', { type: 'button', 'aria-label': 'Ajouter une place', html: ICONS.plus });
    const sync = () => { val.textContent = String(pending); minus.disabled = pending <= Math.max(1, v.stats.registered); };
    const change = (d) => {
      pending = Math.max(Math.max(1, v.stats.registered), pending + d);
      sync();
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (pending === m.capacity) return;
        try { const nv = await api('PATCH', `/api/admin/matches/${m.id}`, { capacity: pending }); onChange(nv); toast(`${pending} places`); }
        catch (e) { toast(e.message, 'error'); }
      }, 600);
    };
    minus.addEventListener('click', () => change(-1));
    plus.addEventListener('click', () => change(1));
    sync();
    return h('div.stepper', [minus, val, plus]);
  }

  function attendanceControl(r, onChange) {
    const set = async (value) => {
      const next = r.attendance === value ? 'unknown' : value;
      try { onChange(await api('PATCH', `/api/admin/registrations/${r.id}`, { attendance: next })); }
      catch (e) { toast(e.message, 'error'); }
    };
    return h('span.att', { role: 'group', 'aria-label': `Présence de ${r.first_name}` }, [
      h('button.att-p', { type: 'button', 'aria-pressed': String(r.attendance === 'present'), title: 'Présent', onclick: () => set('present') }, 'Présent'),
      h('button.att-a', { type: 'button', 'aria-pressed': String(r.attendance === 'absent'), title: 'Absent', onclick: () => set('absent') }, 'Absent'),
    ]);
  }

  function playersCard(v, onChange) {
    const regs = v.registrations;
    const filters = [
      ['all', 'Tous', () => true],
      ['unpaid', 'À encaisser', (r) => r.payment_status !== 'paid'],
      ['paid', 'Payés', (r) => r.payment_status === 'paid'],
      ['subs', 'Abonnés', (r) => r.tier !== 'standard'],
      ['att', 'Présence à saisir', (r) => r.attendance === 'unknown'],
    ];
    const current = filters.find((f) => f[0] === ui.filter) || filters[0];

    const quick = (r) => {
      if (r.payment_status === 'paid') return null;
      const label = r.payment_method === 'cash' ? 'Espèces encaissées' : 'Marquer comme payé';
      const b = h('button.btn.btn-sm.btn-quick', { type: 'button' }, [icon('check'), label]);
      b.addEventListener('click', withBusy(b, async () => {
        try {
          const nv = await api('PATCH', `/api/admin/registrations/${r.id}`, { payment_status: 'paid' });
          onChange(nv); toast(`${r.first_name} : payé ✅`);
        } catch (e) { toast(e.message, 'error'); }
      }));
      return b;
    };

    const rows = regs.map((r, i) => (current[2](r) ? h('div.prow', [
      h('span.n.num', String(i + 1)),
      h('span.name', [h('a', { href: `#/player/${r.player_id}` }, r.first_name), r.source === 'admin' ? h('span.src', 'ajouté') : null]),
      h('span.badges', [
        h('span.col-tier', h(`span.badge.tier-${r.tier}`, r.tier_label)),
        h('span.col-price.num', euros(r.price_cents)),
        h('span.method', h('span.badge', METHOD_LABEL[r.payment_method])),
        h('span.status', h(`span.badge.${r.payment_status}`, r.payment_status === 'paid' ? '✓ Payé' : STATUS_LABEL[r.payment_status])),
      ]),
      h('span.col-att', attendanceControl(r, onChange)),
      h('span.actions', [
        quick(r),
        h('button.btn.btn-ghost.btn-sm.btn-edit', { type: 'button', 'aria-label': `Modifier ${r.first_name}`, title: 'Modifier', onclick: () => editRegistrationSheet(r, onChange) }, [icon('edit'), h('span.lbl', 'Modifier')]),
      ]),
    ]) : null)).filter(Boolean);

    const full = v.stats.remaining === 0;
    return h('section.card.stack', [
      h('div.row.between', [
        h('h2.section-title', `Joueurs (${regs.length})`),
        h('button.btn.btn-sm', { type: 'button', disabled: full, title: full ? 'Match complet : ajoute une place d’abord' : '', onclick: () => addPlayerSheet(v, onChange) }, [icon('plus'), 'Ajouter']),
      ]),
      v.match.is_past && v.stats.present + v.stats.absent < regs.length
        ? alertBox('info', '✅', 'Match terminé : indique qui était Présent ou Absent. Seules les présences comptent pour la fidélité.')
        : null,
      regs.length ? h('div.filters', { role: 'group', 'aria-label': 'Filtrer' }, filters.map(([k, l, f]) =>
        h('button', { type: 'button', 'aria-pressed': String(ui.filter === k), onclick: () => { ui.filter = k; onChange(v); } }, `${l} · ${regs.filter(f).length}`))) : null,
      regs.length
        ? h('div.ptable', [
            h('div.ptable-head', [h('span', '#'), h('span', 'Joueur'), h('span', 'Statut'), h('span', 'Tarif'), h('span', 'Moyen'), h('span', 'Paiement'), h('span', 'Présence'), h('span')]),
            ...(rows.length ? rows : [h('p.muted', { style: 'padding:8px 2px' }, 'Aucun joueur dans ce filtre.')]),
          ])
        : h('p.muted', 'Aucun inscrit pour l’instant. Copie un lien et envoie-le sur WhatsApp !'),
    ]);
  }

  function warnings(w) {
    if (!w) return [];
    const out = [];
    if (w.default_password) out.push(alertBox('warn', '🔐', ['Mot de passe provisoire (« foot2026 ») encore actif. ', h('a', { href: '#/settings' }, 'Le changer')]));
    if (w.players_to_review) {
      out.push(alertBox('warn', '👥', [`${F.plural(w.players_to_review, 'fiche à vérifier', 'fiches à vérifier')} : possible doublon d’une ancienne fiche sans numéro. `, h('a', { href: '#/players', onclick: () => { ui.playerFilter = 'review'; } }, 'Voir')]));
    }
    if (w.subscribers_without_phone) {
      out.push(alertBox('info', '📱', [`${F.plural(w.subscribers_without_phone, 'abonné sans numéro', 'abonnés sans numéro')} : ajoute leur numéro pour qu’ils soient reconnus (et paient 5 €). `, h('a', { href: '#/players', onclick: () => { ui.playerFilter = 'nophone'; } }, 'Compléter')]));
    }
    if (w.missing_card_links && w.missing_card_links.length) {
      out.push(alertBox('info', '💳', [`Lien de paiement ${w.missing_card_links.map((c) => euros(c)).join(' et ')} manquant : les joueurs concernés ne pourront pas payer par carte. `, h('a', { href: '#/settings' }, 'Réglages')]));
    }
    return out;
  }

  function matchPanel(v, { current, warn } = {}) {
    ui.view = v;
    const m = v.match;
    const rerender = (nv) => {
      ui.view = nv;
      const scroll = window.scrollY;
      mount(current ? 'match' : 'history', matchPanel(nv, { current, warn }));
      window.scrollTo(0, scroll);
    };

    const head = h('header.page-head', [
      h('div.row.between', [
        current ? h('p.eyebrow', m.is_past ? 'Match terminé' : 'Match de la semaine')
          : h('a.back-link', { href: '#/history' }, [icon('back'), 'Historique']),
        h('a.btn.btn-ghost.btn-sm', { href: `#/edit/${m.id}` }, [icon('edit'), 'Modifier le match']),
      ]),
      h('h1', F.dayLong(m.date)),
      h('div.sub', [
        h('span.num', [icon('clock'), F.time(m.time)]),
        h('span', [icon('pin'), m.location]),
        h('span.num', [icon('euro'), `${euros(m.price_cents)} · ${euros(m.subscriber_price_cents)} abonnés`]),
        m.season_name ? h('span', [icon('calendar'), `Saison ${m.season_name}`]) : null,
      ]),
    ]);

    const parts = [...warnings(warn), head, statCards(v)];
    if (!m.is_past) {
      parts.push(h('div.split', [shareCard(v, rerender), phaseCard(v, rerender)]));
      const odd = [m.price_cents, m.subscriber_price_cents].filter((c) => c > 0 && c !== 500 && c !== 1000);
      if (odd.length) {
        parts.push(alertBox('warn', '💳', `Tarif ${odd.map((c) => euros(c)).join(' / ')} : aucun lien bancaire ne correspond à ce montant (liens disponibles : 5 € et 10 €). Les joueurs concernés devront payer en espèces.`));
      } else if (m.missing_card_links && m.missing_card_links.length && !warn) {
        parts.push(alertBox('info', '💳', [`Lien de paiement ${m.missing_card_links.map((c) => euros(c)).join(' et ')} manquant. `, h('a', { href: '#/settings' }, 'Réglages')]));
      }
    } else {
      parts.push(revenueCard(v));
    }
    parts.push(playersCard(v, rerender));
    if (!m.is_past) parts.push(revenueCard(v));
    if (current) {
      parts.push(h('a.btn.btn-ghost.btn-block', { href: '#/new', style: 'min-height:60px' }, [icon('calendar'), 'Créer le prochain foot']));
    }
    return parts;
  }

  /* =========================================================
     Vues
     ========================================================= */

  async function dashboardView() {
    loading('match');
    const o = await api('GET', '/api/admin/overview');
    if (!o.current) {
      const d = o.next_defaults;
      mount('match', [
        ...warnings(o.warnings),
        h('section.card.empty-state', [
          h('div.big-emoji', '🗓️'),
          h('h2', 'Aucun foot à venir'),
          h('p', `Crée le match du ${F.dayLong(d.date)} en un clic : les infos du dernier match sont reprises.`),
          h('a.btn.btn-primary.btn-xl', { href: '#/new', style: 'margin-top:8px' }, 'Créer le prochain foot'),
        ]),
      ]);
      return;
    }
    mount('match', matchPanel(o.current, { current: true, warn: o.warnings }));
  }

  async function matchDetailView(id) {
    loading('history');
    const v = await api('GET', `/api/admin/matches/${id}`);
    mount('history', matchPanel(v, { current: false }));
  }

  async function historyView() {
    loading('history');
    const { matches } = await api('GET', '/api/admin/matches');
    const upcoming = matches.filter((m) => !m.is_past).reverse();
    const past = matches.filter((m) => m.is_past);

    const item = (m) => h('a.hist-item', { href: `#/match/${m.id}` }, [
      h('div', [
        h('div.t', `${F.dayLong(m.date)} — ${F.plural(m.registered, 'joueur', 'joueurs')}`),
        h('div.m', [
          h('span', `${F.time(m.time)} · ${m.location}`),
          !m.is_past ? h(`span.phase-tag.${m.status}`, PHASES[m.status].label) : null,
          m.is_past && m.unpaid ? h('span.badge.cash_due', `${m.unpaid} impayé${m.unpaid > 1 ? 's' : ''}`) : null,
          m.is_past && m.registered && m.present === 0 ? h('span.badge', 'présences à saisir') : null,
        ]),
      ]),
      h('div.hist-grid', [
        h('div.r.num', euros(m.is_past ? m.revenue_collected_cents : m.revenue_expected_cents)),
        h('span.chev', { html: ICONS.chevron }),
      ]),
    ]);

    // Regroupement par saison
    const bySeason = new Map();
    for (const m of past) {
      const k = m.season_name || '—';
      if (!bySeason.has(k)) bySeason.set(k, []);
      bySeason.get(k).push(m);
    }
    mount('history', [
      h('header.page-head', [h('p.eyebrow', 'Archives'), h('h1', 'Historique')]),
      upcoming.length ? h('section.stack', [h('h2.section-title', 'À venir'), h('div.hist-list', upcoming.map(item))]) : null,
      past.length
        ? [...bySeason.entries()].map(([season, list]) => h('section.stack', [
            h('div.row.between', [h('h2.section-title', `Saison ${season}`), h('span.muted.num', `${list.length} matchs · ${euros(list.reduce((a, m) => a + m.revenue_collected_cents, 0))}`)]),
            h('div.hist-list', list.map(item)),
          ]))
        : h('section.stack', [h('h2.section-title', 'Matchs passés'), h('p.muted', 'Les matchs terminés apparaîtront ici automatiquement.')]),
      h('a.btn.btn-ghost.btn-block', { href: '#/new' }, [icon('plus'), 'Créer le prochain foot']),
    ]);
  }

  /** Formulaire de création / modification d'un match. */
  async function matchFormView(id) {
    loading('match');
    const editing = !!id;
    const data = editing ? (await api('GET', `/api/admin/matches/${id}`)).match : (await api('GET', '/api/admin/matches/next-defaults')).defaults;
    let status = data.status;

    const input = (name, attrs) => h('input.input', { id: `f-${name}`, name, ...attrs });
    const f = {
      date: input('date', { type: 'date', value: data.date, required: true }),
      time: input('time', { type: 'time', value: data.time, required: true, step: 300 }),
      location: input('location', { type: 'text', value: data.location, required: true, maxlength: 120 }),
      price: input('price', { type: 'number', value: String(data.price_cents / 100), min: 0, step: 0.5, inputmode: 'decimal', required: true }),
      subPrice: input('sub_price', { type: 'number', value: String((data.subscriber_price_cents ?? 500) / 100), min: 0, step: 0.5, inputmode: 'decimal', required: true }),
      capacity: input('capacity', { type: 'number', value: String(data.capacity), min: 1, max: 200, inputmode: 'numeric', required: true }),
    };
    const segs = h('div.segments');
    const drawSegs = () => segs.replaceChildren(...['priority', 'open', 'invite', 'draft'].concat(editing ? ['closed'] : []).map((value) =>
      h('button', { type: 'button', 'data-value': value, 'aria-pressed': String(status === value), onclick: () => { status = value; drawSegs(); } },
        [PHASES[value].label, h('small', PHASES[value].sub)])));
    drawSegs();

    const err = h('div');
    const submit = h('button.btn.btn-primary.btn-xl.btn-block', { type: 'submit' }, editing ? 'Enregistrer' : 'Publier le match');
    const field = (label, el, hint) => h('div.field', [h('label.label', { for: el.id }, label), el, hint ? h('p.hint', hint) : null]);
    const euroField = (label, el) => h('div.field', [h('label.label', { for: el.id }, label), h('div.input-group', [el, h('span.suffix', '€')])]);

    const form = h('form.card.stack', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        const body = {
          date: f.date.value,
          time: f.time.value,
          location: f.location.value,
          price_cents: toCents(f.price.value),
          subscriber_price_cents: toCents(f.subPrice.value),
          capacity: parseInt(f.capacity.value, 10),
          status,
        };
        await withBusy(submit, async () => {
          try {
            const v = editing ? await api('PATCH', `/api/admin/matches/${id}`, body) : await api('POST', '/api/admin/matches', body);
            toast(editing ? 'Match enregistré ✅' : 'Match publié ✅ — liens générés');
            location.hash = v.match.is_past ? `#/match/${v.match.id}` : '#/';
          } catch (e2) {
            err.replaceChildren(errorBox(e2.message));
          }
        })();
      },
    }, [
      h('div.grid-2', [field('Date', f.date), field('Heure', f.time)]),
      field('Lieu', f.location),
      h('div.grid-2', [euroField('Prix non abonné', f.price), euroField('Prix abonné', f.subPrice)]),
      field('Joueurs max', f.capacity),
      h('p.hint', 'Paiement carte : le lien 5 € ou 10 € des Réglages est choisi automatiquement selon le tarif de chaque joueur.'),
      h('div.field', [h('span.label', 'Phase des inscriptions'), segs, h('p.hint', 'Les 3 liens (Prioritaires, Ouvert, Invitations) sont générés automatiquement à la publication.')]),
      err,
      submit,
    ]);

    const del = editing ? h('button.btn.btn-danger.btn-block', { type: 'button', onclick: async () => {
      const ok = await confirmSheet({ title: 'Supprimer le match ?', message: `Le match du ${F.dayLong(data.date)} et toutes ses inscriptions seront supprimés définitivement (les présences associées ne compteront plus).`, confirmLabel: 'Supprimer' });
      if (!ok) return;
      try { await api('DELETE', `/api/admin/matches/${id}`); toast('Match supprimé'); location.hash = '#/'; }
      catch (e) { toast(e.message, 'error'); }
    } }, [icon('trash'), 'Supprimer ce match']) : null;

    mount(editing ? 'history' : 'match', [
      h('header.page-head', [
        h('a.back-link', { href: editing ? (data.is_past ? `#/match/${id}` : '#/') : '#/', onclick: (e) => { if (history.length > 1) { e.preventDefault(); history.back(); } } }, [icon('back'), 'Retour']),
        h('h1', editing ? 'Modifier le match' : 'Créer le prochain foot'),
        !editing ? h('p.sub', 'Pré-rempli avec les infos du dernier match. Vérifie et publie.') : null,
      ]),
      form,
      del,
    ]);
  }

  /* =========================================================
     Joueurs
     ========================================================= */

  function progressDots(p) {
    const dots = [];
    for (let i = 0; i < p.threshold; i++) dots.push(h(`span.dot${i < p.progress ? '.on' : ''}`));
    return h('span.progress-dots', { title: `${Math.min(p.participations, p.threshold)} / ${p.threshold}` }, dots);
  }

  function playerSummary(p) {
    if (p.subscription !== 'none') return F.plural(p.participations, 'participation', 'participations');
    if (p.loyalty_eligible) return `${p.participations} participations · fidélité à la prochaine inscription`;
    return `${p.participations} / ${p.threshold} participations`;
  }

  function newPlayerSheet() {
    openSheet((close) => {
      const name = h('input.input', { id: 'np-name', placeholder: 'Prénom', maxlength: 30, autocapitalize: 'words', autocomplete: 'off' });
      const phone = h('input.input', { id: 'np-phone', type: 'tel', inputmode: 'tel', placeholder: '06 12 34 56 78', maxlength: 20, autocomplete: 'off' });
      let sub = 'annual';
      const err = h('div');
      const submit = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Créer la fiche');
      const form = h('form.stack', {
        onsubmit: async (e) => {
          e.preventDefault();
          await withBusy(submit, async () => {
            try {
              const d = await api('POST', '/api/admin/players', { first_name: name.value, phone: phone.value.trim() || undefined, subscription: sub });
              close(); toast('Fiche créée ✅'); location.hash = `#/player/${d.player.id}`;
            } catch (e2) {
              err.replaceChildren(errorBox([e2.message, e2.other_player_id ? [' ', h('a', { href: `#/player/${e2.other_player_id}`, onclick: () => close() }, 'Ouvrir cette fiche')] : null]));
            }
          })();
        },
      }, [
        h('div.field', [h('label.label', { for: 'np-name' }, 'Prénom'), name]),
        h('div.field', [h('label.label', { for: 'np-phone' }, 'Numéro de téléphone'), phone,
          h('p.hint', 'C’est grâce à ce numéro qu’il sera reconnu à l’inscription (tarif, priorité).')]),
        h('div.field', [h('span.label', 'Statut'), segmented([['annual', 'Abonné annuel'], ['none', 'Non abonné']], sub, (v) => { sub = v; })]),
        err, submit,
      ]);
      setTimeout(() => name.focus(), 80);
      return [h('h2.sheet-title', 'Nouveau joueur'), form];
    });
  }

  async function playersView() {
    loading('players');
    const { players, season } = await api('GET', '/api/admin/players');
    const counts = {
      all: players.length,
      subs: players.filter((p) => p.subscriber).length,
      eligible: players.filter((p) => p.loyalty_eligible).length,
      none: players.filter((p) => !p.subscriber).length,
    };
    const filters = [
      ['all', 'Tous', () => true],
      ['subs', 'Abonnés', (p) => p.subscriber],
      ['none', 'Non abonnés', (p) => !p.subscriber],
      ['eligible', 'Fidélité débloquée', (p) => p.loyalty_eligible],
      ['nophone', 'Numéro à renseigner', (p) => p.missing_phone],
      ['review', 'À vérifier', (p) => p.needs_review],
      ['homonyms', 'Homonymes', (p) => p.homonyms],
    ];
    const listEl = h('div.player-list');
    const search = h('input.input.small', { type: 'search', placeholder: 'Rechercher (prénom ou numéro)', value: ui.playerSearch, autocomplete: 'off' });
    const filterBar = h('div.filters', { role: 'group' });

    const draw = () => {
      const f = filters.find((x) => x[0] === ui.playerFilter) || filters[0];
      const q = ui.playerSearch.trim();
      const shown = players.filter((p) => f[2](p) && matchesQuery(p, q));
      filterBar.replaceChildren(...filters.map(([k, l, fn]) => h('button', { type: 'button', 'aria-pressed': String(ui.playerFilter === k), onclick: () => { ui.playerFilter = k; draw(); } }, `${l} · ${players.filter(fn).length}`)));
      listEl.replaceChildren(...(shown.length ? shown.map((p) => h('a.player-item', { href: `#/player/${p.id}` }, [
        h('div.pi-main', [
          h('div.pi-name', [p.first_name, p.needs_review ? h('span.badge.review', 'à vérifier') : p.homonyms ? h('span.badge.homo', 'homonyme') : null]),
          h('div.pi-meta', [phoneBadge(p)]),
          h('div.pi-meta', [statusBadge(p.subscription), h('span', playerSummary(p))]),
          p.subscription === 'none' ? progressDots(p) : null,
        ]),
        h('div.pi-side', [
          h('div.pi-price.num', euros(p.price_cents)),
          h(`div.pi-prio${p.priority ? '.on' : ''}`, p.priority ? 'Prioritaire' : 'Non prioritaire'),
        ]),
      ])) : [h('p.muted', { style: 'padding:8px 2px' }, 'Aucun joueur.')]));
    };
    search.addEventListener('input', () => { ui.playerSearch = search.value; draw(); });
    draw();

    mount('players', [
      h('header.page-head', [
        h('div.row.between', [h('p.eyebrow', `Saison ${season ? season.name : ''}`), h('button.btn.btn-sm', { type: 'button', onclick: newPlayerSheet }, [icon('plus'), 'Nouveau joueur'])]),
        h('h1', 'Joueurs'),
        h('p.sub', `${counts.all} fiches · ${counts.subs} abonnés${counts.eligible ? ` · ${counts.eligible} fidélité débloquée` : ''}${players.some((p) => p.missing_phone) ? ` · ${players.filter((p) => p.missing_phone).length} sans numéro` : ''}`),
      ]),
      h('section.card.stack', [search, filterBar, listEl]),
    ]);
  }

  async function playerDetailView(id) {
    loading('players');
    const d = await api('GET', `/api/admin/players/${id}`);
    const p = d.player;
    const rerender = () => playerDetailView(id);

    const patch = async (body, msg) => {
      try { await api('PATCH', `/api/admin/players/${p.id}`, body); toast(msg); rerender(); }
      catch (e) { toast(e.message, 'error'); }
    };

    // Statut d'abonnement
    const subCard = h('section.card.stack', [
      h('h2.section-title', 'Abonnement'),
      h('div.segments.three', ['none', 'annual', 'loyalty'].map((s) => h('button', {
        type: 'button', 'aria-pressed': String(p.subscription === s),
        onclick: async () => {
          if (p.subscription === s) return;
          if (s === 'none' && p.subscription !== 'none') {
            const ok = await confirmSheet({ title: 'Retirer l’abonnement ?', message: `${p.first_name} repassera Non abonné (tarif normal, non prioritaire).${p.participations >= p.threshold ? ' Attention : avec ses participations, il redeviendra Abonné fidélité à sa prochaine inscription.' : ''}`, confirmLabel: 'Retirer' });
            if (!ok) return;
          }
          patch({ subscription: s }, `${p.first_name} : ${SUB_LABEL[s]}`);
        },
      }, [SUB_LABEL[s], h('small', s === 'none' ? 'Tarif normal' : s === 'annual' ? '30 € réglés hors site' : 'Acquis après 5 matchs')]))),
      h('p.hint', 'Abonné annuel : à activer quand tu as reçu ses 30 € (aucun paiement n’est créé sur le site).'),
    ]);

    // Participations
    let target = p.participations;
    const val = h('span.val.num', String(target));
    const saveBtn = h('button.btn.btn-sm', { type: 'button', disabled: true }, 'Enregistrer');
    const step = (dlt) => { target = Math.max(0, target + dlt); val.textContent = String(target); saveBtn.disabled = target === p.participations; };
    saveBtn.addEventListener('click', () => patch({ participations: target }, 'Participations corrigées'));
    const partCard = h('section.card.stack', [
      h('div.row.between', [h('h2.section-title', 'Fidélité'), p.subscription === 'none' ? progressDots(p) : null]),
      h('p', { style: 'color:var(--text-2)' }, p.subscription !== 'none'
        ? `${p.participations} participations validées cette saison.`
        : p.loyalty_eligible ? `${p.participations} participations validées : sa prochaine inscription sera à ${euros(p.price_cents)} et il deviendra Abonné fidélité.`
          : `${p.participations} / ${p.threshold} participations validées. Encore ${p.threshold - p.participations} avant le tarif abonné.`),
      h('div.kv', [
        h('span.k', 'Corriger le compteur'),
        h('div.row', [h('div.stepper', [
          h('button', { type: 'button', 'aria-label': 'Moins', html: ICONS.minus, onclick: () => step(-1) }), val,
          h('button', { type: 'button', 'aria-label': 'Plus', html: ICONS.plus, onclick: () => step(1) }),
        ]), saveBtn]),
      ]),
      h('p.hint', `Présences enregistrées sur le site : ${p.present_season}${p.adjustment ? ` · correction manuelle : ${p.adjustment > 0 ? '+' : ''}${p.adjustment}` : ''}.`),
    ]);

    // Identité : prénom et numéro de téléphone (identifiant unique)
    const nameInput = h('input.input.small', { value: p.first_name, maxlength: 30, autocapitalize: 'words', 'aria-label': 'Prénom' });
    const phoneInput = h('input.input.small', { id: 'pd-phone', type: 'tel', inputmode: 'tel', value: p.phone_display, placeholder: '06 12 34 56 78', maxlength: 20, 'aria-label': 'Numéro de téléphone' });
    const phoneErr = h('div');
    const savePhone = async () => {
      phoneErr.replaceChildren();
      try {
        await api('PATCH', `/api/admin/players/${p.id}`, { phone: phoneInput.value.trim() });
        toast('Numéro enregistré ✅'); rerender();
      } catch (e) {
        phoneErr.replaceChildren(errorBox([e.message, e.other_player_id ? [' ', h('a', { href: `#/player/${e.other_player_id}` }, 'Ouvrir l’autre fiche')] : null]));
      }
    };
    const idCard = h('section.card.stack', [
      h('h2.section-title', 'Identité'),
      h('div.field', [h('span.label', 'Prénom'), h('div.row', [nameInput, h('button.btn.btn-sm', { type: 'button', onclick: () => { if (nameInput.value.trim() !== p.first_name) patch({ first_name: nameInput.value }, 'Prénom modifié'); } }, 'Renommer')])]),
      h('div.field', [
        h('span.label', ['Numéro de téléphone ', p.missing_phone ? h('span.badge.no-phone', 'Numéro à renseigner') : null]),
        h('div.row', [phoneInput, h('button.btn.btn-sm', { type: 'button', onclick: savePhone }, 'Enregistrer')]),
        h('p.hint', 'Identifiant unique du joueur : c’est ce numéro qu’il saisit pour s’inscrire.'),
        phoneErr,
      ]),
    ]);

    // Fiche à vérifier : créée avec un prénom porté par une ancienne fiche sans numéro
    const legacy = d.homonyms.filter((x) => x.missing_phone);
    const reviewCard = p.needs_review ? h('section.card.stack.review-card', [
      h('h2.section-title', 'À vérifier'),
      h('p', { style: 'color:var(--text-2)' }, `Cette fiche a été créée avec un nouveau numéro alors qu’il existe ${legacy.length > 1 ? 'd’anciennes fiches' : 'une ancienne fiche'} « ${p.first_name} » sans numéro. S’il s’agit de la même personne, fusionne pour récupérer son historique et son abonnement.`),
      ...legacy.map((x) => h('button.btn.btn-ghost.btn-block', { type: 'button', onclick: async () => {
        const ok = await confirmSheet({ title: 'Même personne ?', message: `L’ancienne fiche « ${x.first_name} » (sans numéro) sera fusionnée dans celle-ci, qui garde le numéro ${p.phone_display}. Historique, participations et abonnement sont regroupés.`, confirmLabel: 'Fusionner', danger: false });
        if (!ok) return;
        try { await api('POST', `/api/admin/players/${x.id}/merge`, { into_player_id: p.id, phone_from: 'target' }); toast('Fiches fusionnées ✅'); rerender(); }
        catch (e) { toast(e.message, 'error'); }
      } }, `Fusionner avec l’ancienne fiche « ${x.first_name} »`)),
      h('button.btn-link', { type: 'button', onclick: () => patch({ needs_review: false }, 'Marquée comme vérifiée') }, 'Ce n’est pas la même personne'),
    ]) : null;

    // Fusion
    const mergeCard = h('section.card.stack', [
      h('h2.section-title', 'Doublon ?'),
      h('p.hint', 'Si cette fiche a été créée par erreur pour une personne qui en a déjà une, fusionne-la : historique, présences et statut sont regroupés.'),
      d.homonyms.length ? alertBox('info', '👥', `Autre(s) fiche(s) avec le même prénom : ${d.homonyms.map((x) => `${x.first_name} (${x.missing_phone ? 'sans numéro' : x.phone_display})`).join(', ')}`) : null,
      h('button.btn.btn-ghost.btn-block', { type: 'button', onclick: () => mergeSheet(p, d.homonyms) }, 'Fusionner avec une autre fiche…'),
      d.history.length === 0 ? h('button.btn.btn-danger.btn-block', { type: 'button', onclick: async () => {
        if (!(await confirmSheet({ title: 'Supprimer la fiche ?', message: `${p.first_name} n’a aucun match : sa fiche sera supprimée.`, confirmLabel: 'Supprimer' }))) return;
        try { await api('DELETE', `/api/admin/players/${p.id}`); toast('Fiche supprimée'); location.hash = '#/players'; } catch (e) { toast(e.message, 'error'); }
      } }, [icon('trash'), 'Supprimer la fiche']) : null,
    ]);

    // Historique
    const s = d.stats;
    const histCard = h('section.card.stack', [
      h('h2.section-title', 'Historique'),
      h('div.mini-stats', [
        h('div', [h('b.num', String(s.matches)), h('span', 'matchs')]),
        h('div', [h('b.num', String(s.present)), h('span', 'présences')]),
        h('div', [h('b.num', String(s.absent)), h('span', 'absences')]),
        h('div', [h('b.num', euros(s.billed_cents)), h('span', 'facturé')]),
      ]),
      d.history.length ? h('div.hist-rows', d.history.map((x) => h('a.hist-row', { href: `#/match/${x.match_id}` }, [
        h('span.hr-date', F.dayLong(x.date)),
        h(`span.badge.att-${x.attendance}`, x.is_past || x.attendance !== 'unknown' ? ATT_LABEL[x.attendance] : 'À venir'),
        h('span.hr-price.num', euros(x.price_cents)),
        h(`span.badge.${x.payment_status}`, x.payment_status === 'paid' ? 'Payé' : 'Non payé'),
      ]))) : h('p.muted', 'Aucun match pour l’instant.'),
      d.seasons.length > 1 ? h('div.stack', [
        h('p.label', 'Saisons'),
        ...d.seasons.map((x) => h('div.kv.season-row', [h('span', `Saison ${x.name}${x.is_current ? ' (actuelle)' : ''}`), h('span.muted', `${x.label} · ${F.plural(x.participations, 'participation', 'participations')}`)])),
      ]) : null,
    ]);

    mount('players', [
      h('header.page-head', [
        h('a.back-link', { href: '#/players' }, [icon('back'), 'Joueurs']),
        h('h1', p.first_name),
        h('div.sub', [phoneBadge(p), statusBadge(p.subscription), h(`span.pi-prio${p.priority ? '.on' : ''}`, p.priority ? 'Prioritaire' : 'Non prioritaire'), h('span.num', `Tarif actuel : ${euros(p.price_cents)}`)]),
      ]),
      reviewCard,
      h('div.split', [h('div.stack', [idCard, subCard, partCard]), h('div.stack', [mergeCard])]),
      histCard,
    ]);
  }

  function mergeSheet(p, homonyms) {
    openSheet((close) => {
      let players = [];
      let target = null;
      let phoneFrom = 'target';
      const search = h('input.input', { placeholder: 'Rechercher la bonne fiche (prénom ou numéro)', autocomplete: 'off' });
      const list = h('div.pick-list');
      const phoneChoice = h('div');
      const err = h('div');
      const btn = h('button.btn.btn-primary.btn-block', { type: 'button', disabled: true }, 'Fusionner');
      const drawPhone = () => {
        if (!target || p.missing_phone || target.missing_phone || p.phone === target.phone) { phoneChoice.replaceChildren(); return; }
        phoneChoice.replaceChildren(h('div.field', [
          h('span.label', 'Numéro à conserver'),
          segmented([['target', target.phone_display], ['source', p.phone_display]], phoneFrom, (v) => { phoneFrom = v; }),
        ]));
      };
      const draw = () => {
        const q = search.value.trim();
        const shown = players.filter((x) => x.id !== p.id && matchesQuery(x, q))
          .sort((a, b) => (homonyms.some((hm) => hm.id === b.id) ? 1 : 0) - (homonyms.some((hm) => hm.id === a.id) ? 1 : 0)).slice(0, 8);
        list.replaceChildren(...shown.map((x) => h('button.pick', { type: 'button', 'aria-pressed': String(target && target.id === x.id), onclick: () => { target = x; phoneFrom = 'target'; btn.disabled = false; draw(); drawPhone(); } },
          [h('span.pick-name', [x.first_name, h('small.pick-phone', x.missing_phone ? ' · sans numéro' : ` · ${x.phone_display}`)]), h('span.pick-meta', `${x.label} · ${F.plural(x.registrations_total, 'match', 'matchs')}`)])));
      };
      search.addEventListener('input', draw);
      api('GET', '/api/admin/players').then((r) => { players = r.players; draw(); });
      btn.addEventListener('click', async () => {
        if (!target) return;
        try {
          const r = await api('POST', `/api/admin/players/${p.id}/merge`, { into_player_id: target.id, phone_from: phoneFrom });
          close(); toast('Fiches fusionnées ✅'); location.hash = `#/player/${r.player.id}`;
        } catch (e) { err.replaceChildren(errorBox(e.message)); }
      });
      return [
        h('h2.sheet-title', 'Fusionner'),
        h('p', { style: 'color:var(--text-2)' }, `La fiche « ${p.first_name} » sera fusionnée dans la fiche choisie, puis supprimée. Historique, présences et tarifs sont conservés, le meilleur statut est gardé.`),
        search, list, phoneChoice, err, btn,
      ];
    });
  }

  /* =========================================================
     Réglages
     ========================================================= */

  async function settingsView() {
    loading('settings');
    const s = await api('GET', '/api/admin/settings');

    // Liens de paiement par montant
    const linkInput = (cents) => h('input.input', { id: `s-link-${cents}`, type: 'url', value: s.payment_links[cents] || '', placeholder: 'https://…', inputmode: 'url', autocomplete: 'off' });
    const l5 = linkInput(500);
    const l10 = linkInput(1000);
    const linkErr = h('div');
    const linkBtn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Enregistrer les liens');
    const linkForm = h('form.card.stack', {
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy(linkBtn, async () => {
          try {
            await api('PATCH', '/api/admin/settings', { payment_links: { 500: l5.value, 1000: l10.value } });
            linkErr.replaceChildren(); toast('Liens enregistrés ✅');
          } catch (e2) { linkErr.replaceChildren(errorBox(e2.message)); }
        })();
      },
    }, [
      h('h2.section-title', 'Paiement par carte'),
      h('p.hint', 'Le site choisit automatiquement le bon lien selon le tarif calculé pour chaque joueur. Sans lien pour un montant, le joueur est invité à payer en espèces.'),
      h('div.field', [h('label.label', { for: 's-link-500' }, 'Lien de paiement 5 €'), l5, h('p.hint', 'Abonnés annuels et fidélité.')]),
      h('div.field', [h('label.label', { for: 's-link-1000' }, 'Lien de paiement 10 €'), l10, h('p.hint', 'Non abonnés.')]),
      s.legacy_payment_link ? alertBox('info', 'ℹ️', ['Ancien lien unique (plus utilisé) : ', h('span', { style: 'word-break:break-all' }, s.legacy_payment_link)]) : null,
      linkErr, linkBtn,
    ]);

    // Saisons
    const current = s.seasons.find((x) => x.is_current);
    const seasonCard = h('section.card.stack', [
      h('h2.section-title', 'Saison'),
      h('div.kv', [h('span', ['Saison actuelle : ', h('b', current ? current.name : '—')]), current ? h('span.muted', `${F.plural(current.matches, 'match', 'matchs')} · ${current.subscribers} abonnés`) : null]),
      s.seasons.length > 1 ? h('div.stack', s.seasons.filter((x) => !x.is_current).map((x) => h('div.kv.season-row', [h('span', `Saison ${x.name}`), h('span.muted', `${F.plural(x.matches, 'match', 'matchs')} · ${x.subscribers} abonnés · archivée`)]))) : null,
      h('button.btn.btn-ghost.btn-block', { type: 'button', onclick: () => newSeasonSheet(current) }, [icon('calendar'), 'Commencer une nouvelle saison']),
      h('p.hint', 'Les compteurs de fidélité repartent à zéro. Anciens matchs, présences et statuts restent consultables.'),
    ]);

    // Mot de passe
    const cur = h('input.input', { id: 's-cur', type: 'password', autocomplete: 'current-password' });
    const nxt = h('input.input', { id: 's-new', type: 'password', autocomplete: 'new-password', minlength: 10 });
    const pwErr = h('div');
    const pwBtn = h('button.btn.btn-block', { type: 'submit' }, 'Changer le mot de passe');
    const pwForm = h('form.card.stack', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (nxt.value.length < 10) return pwErr.replaceChildren(errorBox('Le nouveau mot de passe doit faire au moins 10 caractères.'));
        await withBusy(pwBtn, async () => {
          try {
            await api('POST', '/api/admin/password', { current: cur.value, next: nxt.value });
            cur.value = ''; nxt.value = ''; pwErr.replaceChildren(alertBox('ok', '✅', 'Mot de passe modifié. Les autres appareils sont déconnectés.'));
          } catch (e2) { pwErr.replaceChildren(errorBox(e2.message)); }
        })();
      },
    }, [
      h('h2.section-title', 'Accès organisateur'),
      s.default_password ? alertBox('warn', '🔐', 'Tu utilises encore le mot de passe provisoire « foot2026 ». Change-le avant de partager le site.') : null,
      h('div.field', [h('label.label', { for: 's-cur' }, 'Mot de passe actuel'), cur]),
      h('div.field', [h('label.label', { for: 's-new' }, 'Nouveau mot de passe'), nxt, h('p.hint', '10 caractères minimum.')]),
      pwErr, pwBtn,
    ]);

    const demo = s.has_demo ? h('section.card.stack.danger-zone', [
      h('h2.section-title', 'Données de démonstration'),
      h('p', { style: 'color:var(--text-2)' }, 'Les matchs de démo (2 octobre + 3 matchs d’historique) et les joueurs fictifs (Thomas, Hugo, Antoine…) ont été créés pour tester. Supprime-les quand tu es prêt à utiliser le site pour de vrai.'),
      h('button.btn.btn-danger.btn-block', { type: 'button', onclick: async () => {
        const ok = await confirmSheet({ title: 'Effacer la démo ?', message: 'Tous les matchs et joueurs de démonstration seront supprimés. Tes propres matchs et joueurs sont conservés.', confirmLabel: 'Effacer' });
        if (!ok) return;
        try { const r = await api('POST', '/api/admin/demo/clear', {}); toast(`${r.deleted} matchs de démo supprimés`); settingsView(); }
        catch (e) { toast(e.message, 'error'); }
      } }, [icon('trash'), 'Supprimer les données de démo']),
    ]) : null;

    mount('settings', [
      h('header.page-head', [h('p.eyebrow', 'Organisation'), h('h1', 'Réglages')]),
      linkForm,
      seasonCard,
      pwForm,
      demo,
      h('button.btn.btn-ghost.btn-block', { type: 'button', onclick: async () => { await api('POST', '/api/admin/logout', {}); loginView(); } }, [icon('logout'), 'Se déconnecter']),
      h('a.btn.btn-ghost.btn-block', { href: '/', target: '_blank', rel: 'noopener' }, [icon('external'), 'Voir la page publique']),
    ]);
  }

  function newSeasonSheet(current) {
    openSheet((close) => {
      const guess = (() => {
        const m = current && current.name.match(/^(\d{4})\D+(\d{4})$/);
        return m ? `${Number(m[1]) + 1}–${Number(m[2]) + 1}` : '';
      })();
      const name = h('input.input', { id: 'ns-name', value: guess, maxlength: 40, placeholder: 'Ex. 2027–2028' });
      const err = h('div');
      const btn = h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Démarrer la saison');
      const form = h('form.stack', {
        onsubmit: async (e) => {
          e.preventDefault();
          const ok = await confirmSheet({ title: 'Confirmer ?', message: `La saison ${name.value || guess} devient la saison actuelle. Les compteurs de fidélité repartent à zéro (rien n’est supprimé).`, confirmLabel: 'Démarrer', danger: false });
          if (!ok) return;
          try {
            await api('POST', '/api/admin/seasons', { name: name.value, carry_annual: form.querySelector('#ns-carry').checked });
            close(); toast('Nouvelle saison démarrée ✅'); settingsView();
          } catch (e2) { err.replaceChildren(errorBox(e2.message)); }
        },
      }, [
        h('div.field', [h('label.label', { for: 'ns-name' }, 'Nom de la saison'), name]),
        switchRow('ns-carry', 'Reconduire les abonnés annuels', false),
        h('p.hint', 'À cocher seulement si les abonnés annuels ont déjà réglé leurs 30 € pour la nouvelle saison. Les abonnés fidélité repartent à zéro.'),
        err, btn,
      ]);
      return [h('h2.sheet-title', 'Nouvelle saison'), form];
    });
  }

  /* =========================================================
     Routeur
     ========================================================= */

  async function route() {
    clearInterval(ui.refreshTimer);
    const hash = location.hash || '#/';
    const active = hash.startsWith('#/history') || hash.startsWith('#/match') ? 'history'
      : hash.startsWith('#/player') ? 'players' : hash.startsWith('#/settings') ? 'settings' : 'match';
    try {
      let m;
      if (hash === '#/' || hash === '#') await dashboardView();
      else if ((m = hash.match(/^#\/match\/(\d+)$/))) await matchDetailView(m[1]);
      else if ((m = hash.match(/^#\/edit\/(\d+)$/))) await matchFormView(m[1]);
      else if ((m = hash.match(/^#\/player\/(\d+)$/))) await playerDetailView(m[1]);
      else if (hash === '#/new') await matchFormView(null);
      else if (hash === '#/players') await playersView();
      else if (hash === '#/history') await historyView();
      else if (hash === '#/settings') await settingsView();
      else { location.hash = '#/'; return; }
      window.scrollTo(0, 0);

      // Rafraîchit le tableau de bord toutes les 30 s (nouvelles inscriptions)
      if (hash === '#/' || hash === '#') {
        ui.refreshTimer = setInterval(async () => {
          if (document.visibilityState !== 'visible' || document.querySelector('dialog[open]') || location.hash.replace('#', '') !== hash.replace('#', '')) return;
          try {
            const o = await api('GET', '/api/admin/overview');
            if (o.current && ui.view && JSON.stringify(o.current) !== JSON.stringify(ui.view)) {
              const y = window.scrollY;
              mount('match', matchPanel(o.current, { current: true, warn: o.warnings }));
              window.scrollTo(0, y);
            }
          } catch { /* silencieux */ }
        }, 30000);
      }
    } catch (err) {
      if (err.status === 401) return loginView();
      errorView(active, err);
    }
  }

  window.addEventListener('hashchange', route);
  route();
})();
