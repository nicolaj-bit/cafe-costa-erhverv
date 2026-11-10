// Erhvervsportalens adfærd i butikken: sender formularen gennem app proxy,
// skifter faner i portalen og viser erhvervsprisen for den valgte kassestørrelse.
(() => {
  // ------------------------------------------------ Opret erhvervsaftale
  for (const form of document.querySelectorAll('[data-erhverv-form]')) {
    if (form.dataset.ready) continue;
    form.dataset.ready = '1';
    const fejl = form.querySelector('[data-erhverv-error]');
    const knap = form.querySelector('button[type="submit"]');
    const done = form.parentElement.querySelector('[data-erhverv-done]');

    const visFejl = (tekst, felt) => {
      fejl.textContent = tekst;
      fejl.hidden = false;
      if (felt) { felt.setAttribute('aria-invalid', 'true'); felt.focus(); }
    };

    form.addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      fejl.hidden = true;
      const ugyldig = [...form.elements].find((el) => el.willValidate && !el.checkValidity());
      if (ugyldig) {
        const label = form.querySelector(`label[for="${ugyldig.id}"]`)?.textContent.trim() ?? 'feltet';
        return visFejl(`Udfyld ${label.toLowerCase()}.`, ugyldig);
      }
      const cvr = form.elements.cvr.value.replace(/^DK/i, '').replace(/[\s-]/g, '');
      if (!/^[1-9]\d{7}$/.test(cvr)) return visFejl('CVR-nummeret skal være 8 cifre.', form.elements.cvr);

      knap.disabled = true;
      knap.textContent = knap.dataset.labelSending;
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: new URLSearchParams(new FormData(form)),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) throw new Error(body?.fejl || 'Aftalen kunne ikke oprettes. Prøv igen, eller ring til os.');
        form.hidden = true;
        done.hidden = false;
        done.focus();
      } catch (err) {
        visFejl(err.message);
      } finally {
        knap.disabled = false;
        knap.textContent = knap.dataset.label;
      }
    });
  }

  // ------------------------------------------------ Faner
  for (const liste of document.querySelectorAll('[data-erhverv-tabs]')) {
    if (liste.dataset.ready) continue;
    liste.dataset.ready = '1';
    const faner = [...liste.querySelectorAll('[role="tab"]')];
    const rod = liste.closest('.erhverv-portal');
    const vaelg = (fane, fokus) => {
      for (const f of faner) {
        const valgt = f === fane;
        f.setAttribute('aria-selected', String(valgt));
        f.tabIndex = valgt ? 0 : -1;
        rod.querySelector(`[data-panel="${f.dataset.tab}"]`).hidden = !valgt;
      }
      if (fokus) fane.focus();
      history.replaceState(null, '', `#${fane.dataset.tab}`);
    };
    liste.addEventListener('click', (e) => { const f = e.target.closest('[role="tab"]'); if (f) vaelg(f); });
    liste.addEventListener('keydown', (e) => {
      const i = faner.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowRight') vaelg(faner[(i + 1) % faner.length], true);
      if (e.key === 'ArrowLeft') vaelg(faner[(i - 1 + faner.length) % faner.length], true);
    });
    const fraAdresse = faner.find((f) => `#${f.dataset.tab}` === location.hash);
    if (fraAdresse) vaelg(fraAdresse);
    // Knapper i panelerne, der skifter fane (f.eks. «Vælg kaffe»).
    rod.addEventListener('click', (e) => {
      const knap = e.target.closest('[data-erhverv-goto]');
      const fane = knap && faner.find((f) => f.dataset.tab === knap.dataset.erhvervGoto);
      if (fane) { vaelg(fane, true); liste.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  }

  // ------------------------------------------------ Fast levering
  document.addEventListener('change', (e) => {
    const valg = e.target.closest('[data-erhverv-plan-valg]');
    if (!valg) return;
    const rytme = valg.closest('[data-erhverv-plan]').querySelector('[data-erhverv-plan-rytme]');
    const fast = valg.value === 'fast';
    rytme.disabled = !fast;
    rytme.hidden = !fast;
    const note = valg.closest('[data-erhverv-plan]').querySelector('[data-erhverv-plan-note]');
    if (note) note.hidden = !fast;
  });

  // ------------------------------------------------ Antal
  document.addEventListener('click', (e) => {
    const knap = e.target.closest('[data-erhverv-antal] [data-trin]');
    if (!knap) return;
    const felt = knap.closest('[data-erhverv-antal]').querySelector('input');
    const nyt = Math.min(99, Math.max(1, (parseInt(felt.value, 10) || 1) + Number(knap.dataset.trin)));
    felt.value = String(nyt);
  });

  // ------------------------------------------------ Min aftale (fast levering)
  // Kundens egne aftaler hentes gennem app proxy'en. Shopify signerer kaldet og
  // fortæller, hvem der er logget ind, så kunden kun ser sine egne.
  const dkDato = (iso) => new Date(iso).toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long' });
  const kr = (n, valuta) => Number(n).toLocaleString('da-DK', { style: 'currency', currency: valuta || 'DKK' });
  const el = (tag, cls, tekst) => { const e = document.createElement(tag); if (cls) e.className = cls; if (tekst != null) e.textContent = tekst; return e; };

  for (const kort of document.querySelectorAll('[data-erhverv-aftale]')) {
    if (kort.dataset.ready) continue;
    kort.dataset.ready = '1';
    fetch(`${kort.dataset.url}?visning=aftale`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then((r) => r.json())
      .then((svar) => {
        if (!svar?.ok || !svar.aftaler?.length) return;
        const liste = kort.querySelector('[data-erhverv-aftale-liste]');
        for (const a of svar.aftaler) {
          const item = el('div', 'erhverv-aftale__item');
          if (a.fejlet) item.append(el('p', 'erhverv-aftale__fejl', 'Den seneste trækning gik ikke igennem. Opdatér kortet på jeres konto — vi har sendt jer en mail med et link.'));
          const dl = el('dl', 'erhverv-aftale__fakta');
          const fakta = [
            [a.fejlet ? 'Skulle trækkes' : 'Næste trækning', a.naeste ? dkDato(a.naeste) : '–'],
            ['Beløb', kr(a.beloeb, a.valuta)],
            ['Rytme', a.rytme || 'Hver måned'],
            ['Kort', a.kort?.sidste4 ? `•••• ${a.kort.sidste4}` : '–'],
          ];
          for (const [k, v] of fakta) { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); dl.append(d); }
          const varer = el('ul', 'erhverv-aftale__varer');
          for (const l of a.linjer) varer.append(el('li', null, `${l.antal} × ${l.kaffe}${l.variant ? ` · ${l.variant}` : ''}`));
          const knapper = el('div', 'erhverv-card__actions');
          for (const [tekst, primaer] of [['Ændr varer', true], ['Spring en måned over'], ['Pause'], ['Opsig']]) {
            const a2 = el('a', `costa-button costa-button--small${primaer ? ' costa-button--primary' : ''}`, tekst);
            a2.href = kort.dataset.konto;
            knapper.append(a2);
          }
          item.append(dl, varer, knapper);
          liste.append(item);
        }
        liste.hidden = false;
        kort.querySelector('[data-erhverv-aftale-tom]').hidden = true;
      })
      .catch(() => {});
  }

  // ------------------------------------------------ Pris for valgt kassestørrelse
  document.addEventListener('change', (e) => {
    const valg = e.target.closest('[data-erhverv-variant]');
    if (!valg) return;
    // Kassestørrelsen vælges med pille-knapper (radio) eller en liste.
    const opt = valg.tagName === 'SELECT' ? valg.selectedOptions[0] : valg;
    const form = valg.closest('form');
    const pris = form.querySelector('[data-erhverv-pris]');
    const liste = form.querySelector('[data-erhverv-liste]');
    if (pris) pris.textContent = opt.dataset.pris;
    if (liste) liste.textContent = opt.dataset.liste;
  });
})();
