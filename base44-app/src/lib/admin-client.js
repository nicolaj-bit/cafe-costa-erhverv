// Ejerens side i Shopify admin. Kører i browseren inde i admin; data hentes
// fra /api/admin-data med App Bridges ID token.

const $ = (id) => document.getElementById(id);
const side = document.body.dataset.side;

/** Laver et element. Tekst sættes altid som tekst, aldrig som HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    el.setAttribute(k, v === true ? "" : String(v));
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
  if (!res.ok) throw new Error((body && body.fejl) || "HTTP " + res.status);
  return body;
}

const toast = (msg, isError) => window.shopify.toast.show(msg, { isError: Boolean(isError) });

const STATUS = {
  afventer: { tekst: "Afventer", tone: "warning" },
  godkendt: { tekst: "Godkendt", tone: "success" },
  afvist: { tekst: "Afvist", tone: "critical" },
};
const KOPPER = { "under-50": "Under 50", "50-150": "50–150", "150-300": "150–300", "over-300": "Over 300" };

const dato = (iso) =>
  iso ? new Date(iso).toLocaleDateString("da-DK", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Copenhagen" }) : "–";

const kundeLink = (gid) => {
  const id = String(gid || "").split("/").pop();
  return id ? "shopify://admin/customers/" + id : null;
};

// ------------------------------------------------------------------ Ansøgninger

let alle = [];
let satser = { 1: 10, 2: 15, 3: 20 };
let valgt = null;

function stat(label, value, tone) {
  return h("s-box", { padding: "base", border: "base", borderRadius: "base", background: "base" },
    h("s-text", { color: "subdued" }, label),
    h("s-heading", {}, h("s-text", tone ? { tone } : {}, value)));
}

function renderStats() {
  const antal = (s) => alle.filter((v) => v.status === s).length;
  $("stats").replaceChildren(
    stat("Afventer", antal("afventer"), antal("afventer") > 0 ? "caution" : null),
    stat("Godkendte", antal("godkendt")),
    stat("Afviste", antal("afvist")),
  );
}

function matcher(v, q) {
  if (!q) return true;
  return [v.firmanavn, v.cvr, v.kontaktperson, v.email, v.by].some((f) => String(f || "").toLowerCase().includes(q));
}

function row(v) {
  const s = STATUS[v.status] || { tekst: v.status, tone: "neutral" };
  return h("s-table-row", {},
    h("s-table-cell", {},
      h("s-stack", { gap: "small-500" },
        h("s-text", { type: "strong" }, v.firmanavn),
        h("s-text", { color: "subdued" }, "CVR " + v.cvr))),
    h("s-table-cell", {},
      h("s-stack", { gap: "small-500" },
        h("s-text", {}, v.kontaktperson),
        h("s-text", { color: "subdued" }, v.email))),
    h("s-table-cell", {}, KOPPER[v.kopper_pr_dag] || v.kopper_pr_dag || "–"),
    h("s-table-cell", {}, dato(v.oprettet || v.created_date)),
    h("s-table-cell", {},
      h("s-stack", { direction: "inline", gap: "small-200" },
        h("s-badge", { tone: s.tone }, s.tekst),
        v.status === "godkendt" && v.prisniveau ? h("s-badge", {}, "Niveau " + v.prisniveau) : null)),
    h("s-table-cell", {}, h("s-button", { "data-id": v.id }, "Se ansøgning")));
}

function renderRows() {
  const q = $("search").value.trim().toLowerCase();
  const status = $("status").value || "alle";
  const vist = alle.filter((v) => (status === "alle" || v.status === status) && matcher(v, q));
  $("rows").replaceChildren(
    ...(vist.length
      ? vist.map(row)
      : [h("s-table-row", {}, h("s-table-cell", {}, status === "afventer" ? "Ingen ansøgninger venter" : "Ingen ansøgninger"))]),
  );
  for (const btn of $("rows").querySelectorAll("s-button[data-id]")) {
    btn.addEventListener("click", () => visDetalje(btn.dataset.id));
  }
}

async function load() {
  $("table").setAttribute("loading", "");
  $("refresh").setAttribute("loading", "");
  $("error").hidden = true;
  try {
    const [liste, s] = await Promise.all([api("list", { status: "alle" }), api("satser").catch(() => null)]);
    alle = liste.virksomheder;
    if (s) satser = s.satser;
    renderStats();
    renderRows();
  } catch (e) {
    $("error-text").textContent = e.message;
    $("error").hidden = false;
  } finally {
    $("table").removeAttribute("loading");
    $("refresh").removeAttribute("loading");
  }
}

function felt(label, value) {
  return h("s-stack", { gap: "small-500" },
    h("s-text", { color: "subdued" }, label),
    h("s-text", {}, value == null || value === "" ? "–" : value));
}

function visDetalje(id) {
  const v = alle.find((x) => x.id === id);
  if (!v) return;
  valgt = v;
  const s = STATUS[v.status] || { tekst: v.status, tone: "neutral" };
  const link = kundeLink(v.shopify_customer_id);

  const niveauVaelger = h("s-choice-list", { label: "Prisniveau", name: "prisniveau", id: "prisniveau" },
    [1, 2, 3].map((n) =>
      h("s-choice", { value: String(n), selected: (v.prisniveau || 1) === n }, "Niveau " + n + " — " + satser[n] + " % rabat")));

  $("detail").setAttribute("heading", v.firmanavn);
  $("detail-body").replaceChildren(
    h("s-stack", { direction: "inline", gap: "small-200" },
      h("s-badge", { tone: s.tone }, s.tekst),
      v.prisniveau ? h("s-badge", {}, "Niveau " + v.prisniveau) : null,
      v.nyhedsbrev ? h("s-badge", { tone: "info" }, "Vil have nyhedsbrev") : null),
    h("s-grid", { gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "base" },
      felt("CVR", v.cvr),
      felt("Kontaktperson", v.kontaktperson),
      felt("E-mail", v.email),
      felt("Telefon", v.telefon),
      felt("Leveringsadresse", [v.leveringsadresse, [v.postnr, v.by].filter(Boolean).join(" ")].filter(Boolean).join(", ")),
      felt("Kopper pr. dag", KOPPER[v.kopper_pr_dag] || v.kopper_pr_dag),
      felt("Maskine", v.maskine),
      felt("Ansøgt", dato(v.oprettet || v.created_date)),
      v.godkendt_dato ? felt("Godkendt", dato(v.godkendt_dato)) : null),
    link ? h("s-link", { href: link, target: "_top" }, "Åbn kunden i Shopify") : null,
    h("s-divider"),
    v.status === "afvist"
      ? h("s-paragraph", { color: "subdued" }, "Ansøgningen er afvist. Du kan stadig godkende den, hvis I har talt sammen.")
      : null,
    niveauVaelger,
  );
  $("approve").textContent = v.status === "godkendt" ? "Skift prisniveau" : "Godkend";
  // Polaris ser bort fra hidden, så knappen slås fra i stedet.
  if (v.status === "afvist") $("reject").setAttribute("disabled", "");
  else $("reject").removeAttribute("disabled");
  $("detail").showOverlay();
}

function mailBesked(mail) {
  return mail && mail.sendt ? "Mail sendt" : "Mailen kunne ikke sendes" + (mail && mail.fejl ? " (" + mail.fejl + ")" : "");
}

async function godkend() {
  if (!valgt) return;
  const valg = $("prisniveau");
  const niveau = Number((valg && valg.values && valg.values[0]) || (valg && valg.value) || 1);
  const btn = $("approve");
  btn.setAttribute("loading", "");
  try {
    const res = await api("godkend", { id: valgt.id, prisniveau: niveau });
    $("detail").hideOverlay();
    toast(valgt.firmanavn + " er godkendt på niveau " + niveau + ". " + mailBesked(res.mail), !(res.mail && res.mail.sendt));
    await load();
  } catch (e) {
    toast("Kunne ikke godkende: " + e.message, true);
  } finally {
    btn.removeAttribute("loading");
  }
}

async function afvis() {
  if (!valgt) return;
  if (!window.confirm("Afvis " + valgt.firmanavn + "? Virksomheden får en kort mail.")) return;
  const btn = $("reject");
  btn.setAttribute("loading", "");
  try {
    const res = await api("afvis", { id: valgt.id });
    $("detail").hideOverlay();
    toast(valgt.firmanavn + " er afvist. " + mailBesked(res.mail), !(res.mail && res.mail.sendt));
    await load();
  } catch (e) {
    toast("Kunne ikke afvise: " + e.message, true);
  } finally {
    btn.removeAttribute("loading");
  }
}

// ------------------------------------------------------------------ Indstillinger

function visRabat(res) {
  const r = res.rabat;
  $("discount-status").textContent = r
    ? "Den automatiske rabat «" + (r.titel || "Erhvervspriser") + "» er " + (r.status === "ACTIVE" ? "aktiv" : String(r.status || "").toLowerCase()) + "."
    : res.gemt
      ? "Rabatten findes ikke i Shopify. Tryk Gem for at oprette den igen."
      : "Rabatten oprettes i Shopify, første gang du trykker Gem.";
}

async function loadSatser() {
  try {
    const res = await api("satser");
    for (const n of [1, 2, 3]) $("niveau-" + n).value = String(res.satser[n]);
    visRabat(res);
  } catch (e) {
    $("discount-status").textContent = "Kunne ikke hente: " + e.message;
  }
}

async function gemSatser() {
  const btn = $("save");
  btn.setAttribute("loading", "");
  $("settings-error").hidden = true;
  try {
    const nye = {};
    for (const n of [1, 2, 3]) nye[n] = Number($("niveau-" + n).value);
    const res = await api("gem-satser", { satser: nye });
    visRabat(res);
    toast("Prisniveauerne er gemt");
  } catch (e) {
    $("settings-error-text").textContent = e.message;
    $("settings-error").hidden = false;
  } finally {
    btn.removeAttribute("loading");
  }
}

// ------------------------------------------------------------------ Start

if (side === "indstillinger") {
  $("side-indstillinger").hidden = false;
  $("save").addEventListener("click", gemSatser);
  loadSatser();
} else {
  $("side-ansoegninger").hidden = false;
  $("refresh").addEventListener("click", load);
  $("search").addEventListener("input", renderRows);
  $("status").addEventListener("change", renderRows);
  $("approve").addEventListener("click", godkend);
  $("reject").addEventListener("click", afvis);
  load();
}
