// Ejerens app i Shopify admin. Kører i browseren inde i admin; data hentes
// fra /api/admin-data med App Bridges ID token. Menu, titellinje, beskeder og
// bekræftelser går gennem App Bridge; alt indhold i rammen bygges her.

const $ = (id) => document.getElementById(id);

/** Laver et element. Tekst sættes altid som tekst, aldrig som HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof window.Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(action, extra = {}) {
  const token = await window.shopify.idToken();
  const res = await fetch("/api/admin-data", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ ...extra, action }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.fejl) || "Fejl " + res.status);
  return body;
}

const besked = (msg, fejl) => window.shopify.toast.show(msg, { isError: Boolean(fejl), duration: fejl ? 8000 : 4000 });

/** Shopify admins eget bekræftelsesvindue. Svarer true ved Ja. */
function bekraeft({ titel, tekst, ja }) {
  const modal = $("bekraeft");
  if (!modal || typeof modal.show !== "function") return Promise.resolve(window.confirm(tekst));
  $("bekraeft-titel").setAttribute("title", titel);
  $("bekraeft-tekst").textContent = tekst;
  $("bekraeft-ja").textContent = ja;
  return new Promise((resolve) => {
    let svar = false;
    const jaKnap = $("bekraeft-ja");
    const nejKnap = $("bekraeft-nej");
    const vedJa = () => { svar = true; modal.hide(); };
    const vedNej = () => modal.hide();
    const lukket = () => {
      jaKnap.removeEventListener("click", vedJa);
      nejKnap.removeEventListener("click", vedNej);
      modal.removeEventListener("hide", lukket);
      resolve(svar);
    };
    jaKnap.addEventListener("click", vedJa);
    nejKnap.addEventListener("click", vedNej);
    modal.addEventListener("hide", lukket);
    modal.show();
  });
}

async function travl(knap, fn) {
  knap.setAttribute("aria-busy", "true");
  knap.disabled = true;
  try {
    return await fn();
  } finally {
    knap.removeAttribute("aria-busy");
    knap.disabled = false;
  }
}

const dato = (iso) => (iso ? new Date(iso).toLocaleDateString("da-DK", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Copenhagen" }) : "–");
const langDato = (iso) => (iso ? new Date(iso).toLocaleDateString("da-DK", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Copenhagen" }) : "–");
const kortDato = (iso) => new Date(iso).toLocaleDateString("da-DK", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Copenhagen" });
const kr = (n, valuta = "DKK") => Number(n || 0).toLocaleString("da-DK", { style: "currency", currency: valuta });
const kg = (n) => (Math.round(n * 10) / 10).toLocaleString("da-DK") + " kg";
const adminLink = (type, id) => (id ? "shopify://admin/" + type + "/" + String(id).split("/").pop() : null);

const STATUS = {
  afventer: "Afventer",
  godkendt: "Godkendt",
  afvist: "Afvist",
  aktiv: "Aktiv",
  fejlet: "Fejlet trækning",
  betalt: "Betalt",
  reserveret: "I en kurv",
  annulleret: "Annulleret",
};
const maerke = (status) => h("span", { class: "maerke maerke--" + status }, STATUS[status] || status);
const KOPPER = { "under-50": "Under 50", "50-150": "50–150", "150-300": "150–300", "over-300": "Over 300" };

function felt(label, ...vaerdi) {
  const tom = vaerdi.every((v) => v == null || v === "");
  return h("div", { class: "felt" }, h("span", { class: "label" }, label), h("span", {}, tom ? "–" : vaerdi));
}

function visFejl(id, e) {
  const el = $(id);
  el.replaceChildren(h("strong", {}, "Noget gik galt. "), e.message);
  el.hidden = false;
}

// ------------------------------------------------------------------ Faner

const FANER = {
  ansoegninger: { titel: "Ansøgninger", sti: "/api/admin-ansoegninger" },
  aftaler: { titel: "Aftaler", sti: "/api/admin-aftaler" },
  kaffevogn: { titel: "Kaffevogn", sti: "/api/admin-kaffevogn" },
  indstillinger: { titel: "Indstillinger", sti: "/api/admin-indstillinger" },
};
const STIER = { "/api/admin": "ansoegninger", "/api/admin-ansoegninger": "ansoegninger", "/api/admin-aftaler": "aftaler", "/api/admin-risteplan": "aftaler", "/api/admin-indstillinger": "indstillinger", "/api/admin-kaffevogn": "kaffevogn" };
const indlaest = new Set();

function visFane(fane, { push = false } = {}) {
  if (!FANER[fane]) fane = "ansoegninger";
  for (const navn of Object.keys(FANER)) $("fane-" + navn).hidden = navn !== fane;
  for (const a of document.querySelectorAll(".tab")) {
    if (a.dataset.fane === fane) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $("titel").setAttribute("title", FANER[fane].titel);
  if (push && location.pathname !== FANER[fane].sti) history.pushState({ fane }, "", FANER[fane].sti + location.search);
  if (!indlaest.has(fane)) {
    indlaest.add(fane);
    if (fane === "ansoegninger") hentAnsoegninger();
    if (fane === "aftaler") { hentAftaler(); hentPlan(); }
    if (fane === "indstillinger") hentSatser();
    if (fane === "kaffevogn") hentKaffevogn();
  }
  window.scrollTo(0, 0);
}

function saetTal(id, n) {
  const el = $(id);
  el.textContent = String(n);
  el.hidden = !n;
}

// ------------------------------------------------------------------ Ansøgninger

let ansoegninger = [];
let satser = { 1: 10, 2: 15, 3: 20 };

function filterVaerdi() {
  const valgt = document.querySelector('input[name="filter"]:checked');
  return valgt ? valgt.value : "afventer";
}

function matcher(v, q) {
  if (!q) return true;
  return [v.firmanavn, v.cvr, v.kontaktperson, v.email, v.by].some((f) => String(f || "").toLowerCase().includes(q));
}

function ansoegningsLinje(v) {
  const handling = v.status === "afventer"
    ? h("button", { class: "btn btn--primary", onclick: () => visAnsoegning(v.id) }, "Godkend")
    : h("button", { class: "btn", onclick: () => visAnsoegning(v.id) }, v.status === "godkendt" ? "Se aftale" : "Se ansøgning");
  return h("article", { class: "linje" },
    h("div", { class: "linje__hoved" },
      h("h3", {}, v.firmanavn),
      h("span", { class: "mono muted" }, "CVR " + v.cvr)),
    h("div", { class: "linje__info small" },
      h("span", {}, v.kontaktperson),
      h("span", { class: "muted" }, [v.postnr, v.by].filter(Boolean).join(" "))),
    h("div", { class: "linje__info small" },
      h("span", { class: "label" }, "Oprettet"),
      h("span", {}, dato(v.oprettet || v.created_date))),
    maerke(v.status),
    h("div", { class: "linje__handling" }, handling));
}

function visAnsoegningsListe() {
  const q = $("soeg").value.trim().toLowerCase();
  const filter = filterVaerdi();
  const vist = ansoegninger.filter((v) => (filter === "alle" || v.status === filter) && matcher(v, q));
  $("ans-liste").replaceChildren(...(vist.length
    ? vist.map(ansoegningsLinje)
    : [h("p", { class: "tom" }, filter === "afventer" && !q ? "Ingen nye ansøgninger. Godt gået." : "Ingen ansøgninger her.")]));
}

async function hentAnsoegninger() {
  $("ans-fejl").hidden = true;
  try {
    const [liste, s] = await Promise.all([api("list", { status: "alle" }), api("satser").catch(() => null)]);
    ansoegninger = liste.virksomheder;
    if (s) satser = s.satser;
    saetTal("tal-ansoegninger", ansoegninger.filter((v) => v.status === "afventer").length);
    visAnsoegningsListe();
  } catch (e) {
    $("ans-liste").replaceChildren();
    visFejl("ans-fejl", e);
  }
}

function lukDetalje(liste, detalje) {
  $(detalje).hidden = true;
  $(detalje).replaceChildren();
  $(liste).hidden = false;
  window.scrollTo(0, 0);
}

function visAnsoegning(id) {
  const v = ansoegninger.find((x) => x.id === id);
  if (!v) return;
  const nuvaerende = v.prisniveau || 2;
  const rabatValg = h("fieldset", { class: "valg-gruppe", "aria-label": "Rabat" },
    [1, 2, 3].map((n) =>
      h("label", { class: "valg" },
        h("input", { type: "radio", name: "rabat", value: String(n), checked: nuvaerende === n }),
        h("span", {}, satser[n] + " % rabat"))));

  const knapper = [];
  if (v.status === "godkendt") {
    knapper.push(h("button", { class: "btn btn--primary", onclick: (e) => godkend(v, e.currentTarget) }, "Gem rabat"));
  } else {
    knapper.push(h("button", { class: "btn btn--primary", onclick: (e) => godkend(v, e.currentTarget) }, "Godkend"));
  }
  if (v.status !== "afvist") knapper.push(h("button", { class: "btn", onclick: (e) => afvis(v, e.currentTarget) }, "Afvis"));
  knapper.push(h("button", { class: "btn btn--link", onclick: (e) => slet(v, e.currentTarget) }, "Slet ansøgningen"));

  const kunde = adminLink("customers", v.shopify_customer_id);
  $("ans-detalje").replaceChildren(
    h("div", {}, h("button", { class: "btn tilbage", onclick: () => lukDetalje("ans-liste-visning", "ans-detalje") }, "← Alle ansøgninger")),
    h("div", { class: "stack stack--s" },
      h("div", { class: "row" }, maerke(v.status), v.nyhedsbrev ? h("span", { class: "maerke maerke--afvist" }, "Vil have nyhedsbrev") : null),
      h("h1", {}, v.firmanavn),
      h("p", { class: "mono muted" }, "CVR " + v.cvr)),
    h("div", { class: "kort stack" },
      h("div", { class: "felter" },
        felt("Kontaktperson", v.kontaktperson),
        felt("E-mail", v.email ? h("a", { href: "mailto:" + v.email }, v.email) : null),
        felt("Telefon", v.telefon ? h("a", { href: "tel:" + v.telefon }, v.telefon) : null),
        felt("Leveringsadresse", [v.leveringsadresse, [v.postnr, v.by].filter(Boolean).join(" ")].filter(Boolean).join(", ")),
        felt("Kopper om dagen", KOPPER[v.kopper_pr_dag] || v.kopper_pr_dag),
        felt("Kaffemaskine", v.maskine),
        felt("Oprettet", dato(v.oprettet || v.created_date)),
        v.godkendt_dato ? felt("Godkendt", dato(v.godkendt_dato)) : null),
      kunde ? h("p", {}, h("a", { href: kunde, target: "_top" }, "Åbn kunden i Shopify →")) : null),
    h("div", { class: "kort stack" },
      h("h2", {}, v.status === "godkendt" ? "Kundens rabat" : "Hvilken rabat skal de have?"),
      h("p", { class: "muted small" }, "Kunden ser kun sin egen rabat, ikke de andre."),
      rabatValg,
      v.status === "afvist" ? h("p", { class: "muted small" }, "Ansøgningen er afvist. Du kan stadig godkende den, hvis I har talt sammen.") : null,
      h("div", { class: "handlinger" }, knapper)),
  );
  $("ans-liste-visning").hidden = true;
  $("ans-detalje").hidden = false;
  window.scrollTo(0, 0);
}

const mailTekst = (mail) => (mail && mail.sendt ? " Kunden har fået en mail." : " Mailen kunne ikke sendes — giv kunden besked selv.");

async function godkend(v, knap) {
  const valgt = document.querySelector('input[name="rabat"]:checked');
  const niveau = Number(valgt ? valgt.value : 2);
  await travl(knap, async () => {
    try {
      const res = await api("godkend", { id: v.id, prisniveau: niveau });
      besked(v.firmanavn + " har nu " + satser[niveau] + " % rabat." + (v.status === "godkendt" ? "" : mailTekst(res.mail)), !(res.mail && res.mail.sendt) && v.status !== "godkendt");
      lukDetalje("ans-liste-visning", "ans-detalje");
      await hentAnsoegninger();
    } catch (e) {
      besked("Kunne ikke godkende: " + e.message, true);
    }
  });
}

async function afvis(v, knap) {
  const ok = await bekraeft({ titel: "Afvis " + v.firmanavn + "?", tekst: "Virksomheden får en kort mail om, at de ikke kan blive erhvervskunde lige nu.", ja: "Afvis" });
  if (!ok) return;
  await travl(knap, async () => {
    try {
      const res = await api("afvis", { id: v.id });
      besked(v.firmanavn + " er afvist." + mailTekst(res.mail), !(res.mail && res.mail.sendt));
      lukDetalje("ans-liste-visning", "ans-detalje");
      await hentAnsoegninger();
    } catch (e) {
      besked("Kunne ikke afvise: " + e.message, true);
    }
  });
}

async function slet(v, knap) {
  const ok = await bekraeft({ titel: "Slet ansøgningen?", tekst: "Ansøgningen fra " + v.firmanavn + " slettes. Kunden bliver i Shopify, men mister sin erhvervsrabat. Der sendes ingen mail.", ja: "Slet" });
  if (!ok) return;
  await travl(knap, async () => {
    try {
      await api("slet", { id: v.id });
      besked("Ansøgningen fra " + v.firmanavn + " er slettet.");
      lukDetalje("ans-liste-visning", "ans-detalje");
      await hentAnsoegninger();
    } catch (e) {
      besked("Kunne ikke slette: " + e.message, true);
    }
  });
}

// ------------------------------------------------------------------ Aftaler

let aftaleListe = [];

function talBoks(label, vaerdi) {
  return h("div", { class: "kort stack stack--s" }, h("span", { class: "label" }, label), h("span", { class: "tal" }, vaerdi));
}

const varerTekst = (linjer) => linjer.map((l) => l.antal + " × " + l.kaffe + (l.variant ? " (" + l.variant + ")" : "")).join(", ");

function aftaleLinje(a) {
  return h("article", { class: "linje" + (a.status === "fejlet" ? " linje--fejlet" : "") },
    h("div", { class: "linje__hoved" },
      h("h3", {}, a.kunde),
      h("span", { class: "small muted" }, varerTekst(a.linjer))),
    h("div", { class: "linje__info small" },
      h("span", { class: "label" }, a.status === "fejlet" ? "Skulle trækkes" : "Næste trækning"),
      h("span", {}, langDato(a.naeste))),
    h("div", { class: "linje__info small" },
      h("span", { class: "label" }, a.rytme || "Fast levering"),
      h("span", { class: "mono" }, kr(a.beloeb, a.valuta))),
    maerke(a.status),
    h("div", { class: "linje__handling" }, h("button", { class: "btn" + (a.status === "fejlet" ? " btn--primary" : ""), onclick: () => visAftale(a.id) }, "Se aftale")));
}

async function hentAftaler() {
  $("aft-fejl").hidden = true;
  try {
    const res = await api("aftaler");
    aftaleListe = res.aftaler;
    const fejlede = aftaleListe.filter((a) => a.status === "fejlet").length;
    const pr30 = aftaleListe.filter((a) => a.status === "aktiv").reduce((sum, a) => sum + a.beloeb, 0);
    saetTal("tal-aftaler", fejlede);
    $("aft-tal").replaceChildren(
      talBoks("Aktive aftaler", aftaleListe.filter((a) => a.status === "aktiv").length),
      talBoks("Fejlede trækninger", fejlede),
      talBoks("Pr. levering i alt", kr(pr30)));
    $("aft-liste").replaceChildren(...(aftaleListe.length
      ? aftaleListe.map(aftaleLinje)
      : [h("p", { class: "tom" }, "Ingen faste leveringer endnu. De kommer her, når en erhvervskunde vælger fast levering i portalen.")]));
  } catch (e) {
    $("aft-liste").replaceChildren();
    visFejl("aft-fejl", e);
  }
}

function visAftale(id) {
  const a = aftaleListe.find((x) => x.id === id);
  if (!a) return;
  $("aft-detalje").replaceChildren(
    h("div", {}, h("button", { class: "btn tilbage", onclick: () => lukDetalje("aft-liste-visning", "aft-detalje") }, "← Alle aftaler")),
    h("div", { class: "stack stack--s" },
      h("div", { class: "row" }, maerke(a.status)),
      h("h1", {}, a.kunde),
      h("p", { class: "muted" }, a.kontakt + (a.email ? " · " + a.email : ""))),
    a.note ? h("div", { class: "besked " + (a.status === "fejlet" ? "besked--fejl" : "besked--info") }, a.note) : null,
    h("div", { class: "kort stack" },
      h("div", { class: "felter" },
        felt(a.status === "fejlet" ? "Skulle trækkes" : "Næste trækning", langDato(a.naeste)),
        felt("Beløb pr. levering", kr(a.beloeb, a.valuta)),
        felt("Rytme", a.rytme),
        felt("Kort", a.kort && a.kort.sidste4 ? (a.kort.type ? a.kort.type + " " : "") + "•••• " + a.kort.sidste4 : null),
        felt("Kunde siden", dato(a.start)),
        felt("Leveringer indtil nu", a.antalOrdrer)),
      h("div", { class: "stack stack--s" },
        h("span", { class: "label" }, "Varer"),
        h("ul", { class: "small" }, a.linjer.map((l) => h("li", {}, l.antal + " × " + l.kaffe + (l.variant ? " · " + l.variant : "")))))),
    h("div", { class: "handlinger" },
      h("a", { class: "btn btn--harbor", href: adminLink("orders", a.senesteOrdre.id), target: "_top" }, "Seneste ordre " + a.senesteOrdre.navn),
      h("a", { class: "btn", href: adminLink("customers", a.kundeId), target: "_top" }, "Åbn kunden")),
    h("p", { class: "muted small" }, "Ændringer, pause og opsigelse klarer kunden selv under «Abonnementer» på sin konto. Du kan også gøre det i appen Shopify Subscriptions."),
  );
  $("aft-liste-visning").hidden = true;
  $("aft-detalje").hidden = false;
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ Risteplan

let planUger = 0;
const TYPE = { fast: "Fast levering", enkelt: "Enkeltkøb" };

function tabel(id, overskrifter, raekker, tomTekst) {
  const hoved = h("thead", {}, h("tr", {}, overskrifter.map(([t, tal]) => h("th", tal ? { class: "tal-celle" } : {}, t))));
  const krop = h("tbody", {}, raekker.length ? raekker : h("tr", {}, h("td", { colspan: overskrifter.length, class: "muted" }, tomTekst)));
  $(id).replaceChildren(hoved, krop);
}

async function hentPlan() {
  $("plan-fejl").hidden = true;
  $("uge-titel").textContent = planUger === 0 ? "Denne uge" : planUger === 1 ? "Næste uge" : planUger === -1 ? "Sidste uge" : planUger > 0 ? "Om " + planUger + " uger" : -planUger + " uger siden";
  try {
    const p = await api("risteplan", { uger: planUger });
    const slut = new Date(new Date(p.til).getTime() - 1);
    $("uge-dato").textContent = kortDato(p.fra) + " – " + kortDato(slut.toISOString());

    tabel("plan-ialt", [["Kaffe"], ["I alt", true], ["Bestilt", true], ["Fast levering", true]],
      p.ialt.map((r) => h("tr", {},
        h("td", {}, h("strong", {}, r.kaffe), r.ukendt ? h("div", { class: "small muted" }, r.ukendt + " stk. uden vægt i navnet") : null),
        h("td", { class: "tal-celle" }, h("strong", {}, kg(r.kg))),
        h("td", { class: "tal-celle" }, kg(r.ventendeKg)),
        h("td", { class: "tal-celle" }, kg(r.forventetKg)))),
      "Intet at riste i ugen.");

    tabel("plan-ventende", [["Kunde"], ["Kaffe"], ["Kg", true], ["Ordre"], ["Type"]],
      p.ventende.map((x) => h("tr", {},
        h("td", {}, h("strong", {}, x.kunde)),
        h("td", {}, x.antal + " × " + x.kaffe + " · " + x.variant),
        h("td", { class: "tal-celle" }, x.kg ? kg(x.kg) : "–"),
        h("td", {}, x.ordre, h("div", { class: "small muted" }, kortDato(x.dato))),
        h("td", {}, TYPE[x.type] || TYPE.enkelt))),
      "Ingen ordrer venter.");

    tabel("plan-forventede", [["Kunde"], ["Kaffe"], ["Kg", true], ["Dag"], ["Rytme"]],
      p.forventede.map((x) => h("tr", {},
        h("td", {}, h("strong", {}, x.kunde)),
        h("td", {}, x.antal + " × " + x.kaffe + " · " + x.variant),
        h("td", { class: "tal-celle" }, x.kg ? kg(x.kg) : "–"),
        h("td", {}, kortDato(x.dato)),
        h("td", {}, x.rytme || "–"))),
      "Ingen faste leveringer i ugen.");
  } catch (e) {
    visFejl("plan-fejl", e);
  }
}

// ------------------------------------------------------------------ Indstillinger

function visRabatStatus(res) {
  const r = res.rabat;
  $("rabat-status").textContent = r
    ? r.status === "ACTIVE" ? "✓ Rabatterne er slået til i Shopify." : "En eller flere rabatter er slået fra i Shopify. Tryk Gem rabatter for at slå dem til igen."
    : res.gemt
      ? "Rabatten mangler i Shopify. Tryk Gem rabatter for at lave den igen."
      : "Tryk Gem rabatter for at slå rabatten til i Shopify.";
}

async function hentSatser() {
  try {
    const res = await api("satser");
    satser = res.satser;
    for (const n of [1, 2, 3]) $("sats-" + n).value = String(res.satser[n]);
    visRabatStatus(res);
  } catch (e) {
    visFejl("ind-fejl", e);
  }
}

async function gemSatser(e) {
  $("ind-fejl").hidden = true;
  await travl(e.currentTarget, async () => {
    try {
      const nye = {};
      for (const n of [1, 2, 3]) nye[n] = Number($("sats-" + n).value);
      const res = await api("gem-satser", { satser: nye });
      satser = res.satser;
      visRabatStatus(res);
      besked("Rabatterne er gemt");
    } catch (err) {
      visFejl("ind-fejl", err);
    }
  });
}


// ------------------------------------------------------------------ Kaffevogn

let kvMaaned = new Date().toISOString().slice(0, 7);
let kvData = null;
let kvValgt = null;

const maanedNavn = (m) => new Date(m + "-15T12:00:00Z").toLocaleDateString("da-DK", { month: "long", year: "numeric", timeZone: "UTC" });
const dagNavn = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("da-DK", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
function flytMaaned(m, n) {
  const [aar, md] = m.split("-").map(Number);
  const d = new Date(Date.UTC(aar, md - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function dagStatus(dato) {
  const b = kvData.bookinger.filter((x) => x.dato === dato && x.status !== "annulleret");
  const lukket = kvData.lukket.includes(dato);
  if (b.some((x) => x.note && x.status === "betalt")) return { klasse: "fejl", tekst: "Tjek", b, lukket };
  if (b.some((x) => x.status === "betalt")) return { klasse: "betalt", tekst: b.find((x) => x.status === "betalt").kontakt || "Betalt", b, lukket };
  if (b.some((x) => x.status === "reserveret")) return { klasse: "reserveret", tekst: "I en kurv", b, lukket };
  if (lukket) return { klasse: "lukket", tekst: "Lukket", b, lukket };
  return { klasse: dato < kvData.idag ? "fortid" : "", tekst: "", b, lukket };
}

function visKalender() {
  $("kv-titel").textContent = maanedNavn(kvMaaned);
  const [aar, md] = kvMaaned.split("-").map(Number);
  const dage = new Date(Date.UTC(aar, md, 0)).getUTCDate();
  const foerste = (new Date(Date.UTC(aar, md - 1, 1)).getUTCDay() + 6) % 7;
  const celler = ["man", "tir", "ons", "tor", "fre", "lør", "søn"].map((d) => h("div", { class: "kal__ugedag", role: "columnheader" }, d));
  for (let i = 0; i < foerste; i++) celler.push(h("div", { class: "kal__dag kal__dag--tom", "aria-hidden": "true" }));
  for (let d = 1; d <= dage; d++) {
    const dato = kvMaaned + "-" + String(d).padStart(2, "0");
    const st = dagStatus(dato);
    celler.push(h("button", {
      class: "kal__dag" + (st.klasse ? " kal__dag--" + st.klasse : ""),
      "aria-pressed": String(kvValgt === dato),
      "aria-label": dagNavn(dato) + (st.tekst ? ", " + st.tekst : ", ledig"),
      onclick: () => visDag(dato),
    }, h("span", {}, d), st.tekst ? h("span", { class: "kal__tekst" }, st.tekst) : null));
  }
  $("kv-kalender").replaceChildren(...celler);
}

function bookingKort(b) {
  const knapper = [];
  if (b.ordre_id) knapper.push(h("a", { class: "btn btn--harbor", href: adminLink("orders", b.ordre_id), target: "_top" }, "Se ordre " + (b.ordre_navn || "")));
  if (b.status !== "annulleret") knapper.push(h("button", { class: "btn btn--link", onclick: (e) => annullerKv(b, e.currentTarget) }, "Frigiv dagen"));
  return h("div", { class: "kort stack" },
    h("div", { class: "row" }, maerke(b.status), b.note ? h("span", { class: "maerke maerke--fejl" }, "Skal tjekkes") : null),
    b.note ? h("div", { class: "besked besked--fejl" }, b.note) : null,
    h("div", { class: "felter" },
      felt("Varighed", b.variant),
      felt("Start", b.start),
      felt("Gæster", b.gaester),
      felt("Adresse", [b.adresse, [b.postnr, b.by].filter(Boolean).join(" ")].filter(Boolean).join(", ")),
      felt("Kontakt", b.kontakt),
      felt("Telefon", b.telefon ? h("a", { href: "tel:" + b.telefon }, b.telefon) : null),
      felt("E-mail", b.email ? h("a", { href: "mailto:" + b.email }, b.email) : null),
      b.status === "reserveret" ? felt("Holdes til", new Date(b.reserveret_til).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Copenhagen" })) : null),
    knapper.length ? h("div", { class: "handlinger" }, knapper) : null);
}

function visDag(dato) {
  kvValgt = dato;
  visKalender();
  const st = dagStatus(dato);
  const alle = kvData.bookinger.filter((x) => x.dato === dato);
  const fortid = dato < kvData.idag;
  $("kv-dag").replaceChildren(
    h("div", { class: "row row--between" },
      h("h2", {}, dagNavn(dato)),
      fortid ? null : h("button", { class: "btn" + (st.lukket ? " btn--primary" : ""), onclick: (e) => lukKv(dato, !st.lukket, e.currentTarget) }, st.lukket ? "Åbn dagen igen" : "Luk dagen")),
    st.lukket ? h("p", { class: "muted" }, "Dagen er lukket. Kunderne kan ikke booke den.") : null,
    ...(alle.length ? alle.map(bookingKort) : [h("p", { class: "tom" }, fortid ? "Ingen booking." : "Ingen booking. Dagen er ledig.")]));
  $("kv-dag").hidden = false;
}

async function hentKaffevogn() {
  $("kv-fejl").hidden = true;
  try {
    kvData = await api("kaffevogn", { maaned: kvMaaned });
    $("kv-postnumre").value = kvData.indstillinger.postnumre.join(", ");
    $("kv-varsel").value = String(kvData.indstillinger.varsel_dage);
    const tjek = kvData.bookinger.filter((b) => b.note && b.status === "betalt").length;
    saetTal("tal-kaffevogn", tjek);
    visKalender();
    if (kvValgt && kvValgt.startsWith(kvMaaned)) visDag(kvValgt);
    else $("kv-dag").hidden = true;
  } catch (e) {
    visFejl("kv-fejl", e);
  }
}

async function lukKv(dato, luk, knap) {
  await travl(knap, async () => {
    try {
      const res = await api("kaffevogn-luk", { dato, luk });
      besked(res.advarsel || (luk ? "Dagen er lukket" : "Dagen er åbnet igen"), Boolean(res.advarsel));
      await hentKaffevogn();
    } catch (e) {
      besked("Kunne ikke gemme: " + e.message, true);
    }
  });
}

async function annullerKv(b, knap) {
  const ok = await bekraeft({
    titel: "Frigiv " + dagNavn(b.dato) + "?",
    tekst: b.ordre_id
      ? "Dagen bliver ledig igen. Ordren " + (b.ordre_navn || "") + " er stadig betalt — refundér den i Shopify, hvis kunden skal have pengene tilbage."
      : "Reservationen slettes, og dagen bliver ledig igen.",
    ja: "Frigiv",
  });
  if (!ok) return;
  await travl(knap, async () => {
    try {
      await api("kaffevogn-annuller", { id: b.id });
      besked("Dagen er frigivet");
      await hentKaffevogn();
    } catch (e) {
      besked("Kunne ikke frigive: " + e.message, true);
    }
  });
}

async function gemKv(e) {
  $("kv-fejl").hidden = true;
  await travl(e.currentTarget, async () => {
    try {
      const postnumre = $("kv-postnumre").value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      kvData = await api("kaffevogn-indstillinger", { postnumre, varsel_dage: Number($("kv-varsel").value) });
      besked("Område og varsel er gemt");
      kvMaaned = kvData.maaned;
      await hentKaffevogn();
    } catch (err) {
      visFejl("kv-fejl", err);
    }
  });
}

// ------------------------------------------------------------------ Start

for (const a of document.querySelectorAll(".tab")) {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    visFane(a.dataset.fane, { push: true });
  });
}
window.addEventListener("popstate", () => visFane(STIER[location.pathname] || "ansoegninger"));

$("soeg").addEventListener("input", visAnsoegningsListe);
$("filter").addEventListener("change", visAnsoegningsListe);
$("uge-forrige").addEventListener("click", () => { planUger = Math.max(-4, planUger - 1); hentPlan(); });
$("uge-naeste").addEventListener("click", () => { planUger = Math.min(8, planUger + 1); hentPlan(); });
$("print").addEventListener("click", () => window.print());
$("gem").addEventListener("click", gemSatser);
$("kv-forrige").addEventListener("click", () => { kvMaaned = flytMaaned(kvMaaned, -1); hentKaffevogn(); });
$("kv-naeste").addEventListener("click", () => { kvMaaned = flytMaaned(kvMaaned, 1); hentKaffevogn(); });
$("kv-gem").addEventListener("click", gemKv);

visFane(STIER[location.pathname] || document.body.dataset.side);
// Tallene på fanerne skal vises, uanset hvilken fane ejeren starter på.
if (!indlaest.has("ansoegninger")) { indlaest.add("ansoegninger"); hentAnsoegninger(); }
if (!indlaest.has("aftaler")) { indlaest.add("aftaler"); hentAftaler(); hentPlan(); }
