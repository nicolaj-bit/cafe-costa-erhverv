// Book kaffevognen: kalender over ledige dage, reservation og kurv.
// Datoerne er dansk tid som YYYY-MM-DD. Optagede dage kommer først fra
// metafeltet (i HTML'en) og opdateres fra app proxy'en, når siden åbnes.
(() => {
  const MAANEDER = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
  const UGEDAGE = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
  const LANGE_UGEDAGE = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
  const GEMT = 'costa-kaffevogn-booking';

  const iso = (aar, md, dag) => `${aar}-${String(md + 1).padStart(2, '0')}-${String(dag).padStart(2, '0')}`;
  const idag = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());
  const dagTekst = (d) => {
    const [a, m, dd] = d.split('-').map(Number);
    const ugedag = LANGE_UGEDAGE[new Date(Date.UTC(a, m - 1, dd)).getUTCDay()];
    return `${ugedag} ${dd}. ${MAANEDER[m - 1]} ${a}`;
  };
  const el = (tag, attrs = {}, tekst) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
    if (tekst != null) e.textContent = tekst;
    return e;
  };

  for (const form of document.querySelectorAll('[data-kaffevogn]')) {
    if (form.dataset.ready) continue;
    form.dataset.ready = '1';

    const grid = form.querySelector('[data-kal-grid]');
    const titel = form.querySelector('[data-kal-titel]');
    const datoFelt = form.querySelector('[data-dato]');
    const valgtTekst = form.querySelector('[data-valgt]');
    const fejl = form.querySelector('[data-fejl]');
    const knap = form.querySelector('button[type="submit"]');
    const telefon = form.dataset.telefon;

    let optaget = new Set(form.dataset.optaget.split(',').filter(Boolean));
    let foerste = form.dataset.foerste || idag();
    const start = (foerste > idag() ? foerste : idag()).split('-').map(Number);
    let aar = start[0];
    let md = start[1] - 1;

    const kanVaelges = (d) => d >= foerste && d >= idag() && !optaget.has(d);

    const tegn = () => {
      titel.textContent = `${MAANEDER[md][0].toUpperCase()}${MAANEDER[md].slice(1)} ${aar}`;
      const celler = UGEDAGE.map((u) => el('span', { class: 'kaffevogn-kal__ugedag', role: 'columnheader' }, u));
      const tom = (new Date(Date.UTC(aar, md, 1)).getUTCDay() + 6) % 7;
      for (let i = 0; i < tom; i++) celler.push(el('span', { class: 'kaffevogn-kal__tom', 'aria-hidden': 'true' }));
      const dage = new Date(Date.UTC(aar, md + 1, 0)).getUTCDate();
      for (let dag = 1; dag <= dage; dag++) {
        const d = iso(aar, md, dag);
        const ledig = kanVaelges(d);
        const b = el('button', {
          type: 'button',
          class: `kaffevogn-kal__dag${ledig ? '' : ' is-optaget'}${datoFelt.value === d ? ' is-valgt' : ''}`,
          'data-dag': d,
          disabled: !ledig,
          'aria-pressed': String(datoFelt.value === d),
          'aria-label': `${dagTekst(d)}, ${ledig ? 'ledig' : 'ikke ledig'}`,
        }, String(dag));
        celler.push(b);
      }
      grid.replaceChildren(...celler);
      // Ingen grund til at gå tilbage før den første dag, der kan bookes.
      const [fa, fm] = (foerste > idag() ? foerste : idag()).split('-').map(Number);
      form.querySelector('[data-kal-forrige]').disabled = aar < fa || (aar === fa && md <= fm - 1);
    };

    const vaelg = (d) => {
      datoFelt.value = d;
      valgtTekst.textContent = `Valgt: ${dagTekst(d)}`;
      valgtTekst.hidden = false;
      fejl.hidden = true;
      tegn();
    };

    grid.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dag]');
      if (b && !b.disabled) vaelg(b.dataset.dag);
    });
    form.querySelector('[data-kal-forrige]').addEventListener('click', () => { md -= 1; if (md < 0) { md = 11; aar -= 1; } tegn(); });
    form.querySelector('[data-kal-naeste]').addEventListener('click', () => { md += 1; if (md > 11) { md = 0; aar += 1; } tegn(); });
    tegn();

    // Friske datoer fra app proxy'en (rydder udløbne reservationer).
    fetch(`${form.dataset.proxy}?visning=kaffevogn`, { headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((svar) => {
        if (!svar?.ok) return;
        optaget = new Set(svar.optaget);
        foerste = svar.foerste_dag || foerste;
        if (datoFelt.value && !kanVaelges(datoFelt.value)) { datoFelt.value = ''; valgtTekst.hidden = true; }
        tegn();
      })
      .catch(() => {});

    const visFejl = (tekst, felt) => {
      fejl.replaceChildren();
      // Uden for området: telefonnummeret skal kunne trykkes på.
      const i = tekst.indexOf(telefon);
      if (i >= 0) {
        fejl.append(tekst.slice(0, i), el('a', { href: `tel:${telefon.replace(/\s/g, '')}` }, telefon), tekst.slice(i + telefon.length));
      } else fejl.textContent = tekst;
      fejl.hidden = false;
      if (felt) { felt.setAttribute('aria-invalid', 'true'); felt.focus(); }
      else fejl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    form.addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      fejl.hidden = true;
      if (!datoFelt.value) return visFejl('Vælg en dag i kalenderen.');
      const ugyldig = [...form.elements].find((x) => x.willValidate && x.type !== 'hidden' && !x.checkValidity());
      if (ugyldig) {
        const label = form.querySelector(`label[for="${ugyldig.id}"]`)?.textContent.trim() ?? 'feltet';
        return visFejl(`Udfyld ${label.toLowerCase()}.`, ugyldig);
      }

      const data = Object.fromEntries(new FormData(form).entries());
      let tidligere = null;
      try { tidligere = JSON.parse(sessionStorage.getItem(GEMT) || 'null'); } catch { /* privat vindue */ }

      knap.disabled = true;
      knap.textContent = 'Holder dagen …';
      try {
        const res = await fetch(form.dataset.proxy, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...data, handling: 'kaffevogn-reserver', erstat: tidligere?.id }),
        });
        const svar = await res.json().catch(() => null);
        if (!res.ok || !svar?.ok) {
          if (res.status === 409) {
            optaget.add(data.dato);
            datoFelt.value = '';
            valgtTekst.hidden = true;
            tegn();
          }
          throw new Error(svar?.fejl || `Dagen kunne ikke reserveres. Ring på ${telefon}.`);
        }

        // Kun én kaffevogn i kurven ad gangen: en tidligere booking fjernes.
        const kurv = await fetch('/cart.js').then((r) => r.json());
        const gamle = kurv.items.filter((x) => x.properties && (x.properties._booking || x.properties._dato));
        for (const g of gamle) {
          await fetch('/cart/change.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: g.key, quantity: 0 }) });
        }

        const tilKurv = await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            items: [{
              id: Number(data.variant_id),
              quantity: 1,
              properties: {
                Dato: svar.dato_tekst,
                Start: data.start,
                'Gæster': data.gaester,
                Adresse: `${data.adresse}, ${data.postnr} ${data.by}`,
                Kontakt: data.kontakt,
                Telefon: data.telefon,
                _booking: svar.id,
                _dato: data.dato,
              },
            }],
          }),
        });
        if (!tilKurv.ok) throw new Error(`Kaffevognen kunne ikke lægges i kurven. Ring på ${telefon}.`);
        try { sessionStorage.setItem(GEMT, JSON.stringify({ id: svar.id, dato: data.dato })); } catch { /* privat vindue */ }
        window.location.href = form.dataset.kurv;
      } catch (err) {
        visFejl(err.message);
        knap.disabled = false;
        knap.textContent = knap.dataset.label;
      }
    });
  }
})();
