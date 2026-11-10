// Erhvervsportalens logik. Kaldes fra to server-ruter:
//   /api/erhverv-proxy  — butikkens formular via Shopifys app proxy (anonym, men signeret af Shopify)
//   /api/admin-data     — ejerens side i Shopify admin (ID token fra App Bridge)
// Entiteten Virksomhed læses og skrives kun her, med asServiceRole, og først
// når kalderen er kontrolleret.
import { z } from "zod";
import { HttpError, adminGraphql, assertNoUserErrors } from "@/lib/shopify.server";

export const TAG = {
  erhverv: "erhverv",
  afventer: "erhverv-afventer",
  godkendt: "erhverv-godkendt",
  afvist: "erhverv-afvist",
  niveau: (n) => `erhverv-niveau-${n}`,
};
const ALLE_STATUS_TAGS = [TAG.afventer, TAG.godkendt, TAG.afvist, TAG.niveau(1), TAG.niveau(2), TAG.niveau(3)];

export const STANDARD_SATSER = { 1: 10, 2: 15, 3: 20 };

// ---------------------------------------------------------------- CVR

/**
 * CVR-nummer: præcis 8 cifre, første ciffer ikke 0. Mellemrum, bindestreger
 * og «DK» foran fjernes. Vi tjekker kun formatet — om virksomheden findes,
 * ser ejeren på, før hun godkender.
 */
export function normaliserCvr(input) {
  const cvr = String(input ?? "").toUpperCase().replace(/^DK/, "").replace(/[\s-]/g, "");
  return /^[1-9]\d{7}$/.test(cvr) ? cvr : null;
}

/** Telefon i E.164, som Shopify kræver. 8 danske cifre får +45 foran. */
export function normaliserTelefon(input) {
  const raw = String(input ?? "").replace(/[\s-]/g, "");
  if (/^\d{8}$/.test(raw)) return `+45${raw}`;
  if (/^00\d{8,14}$/.test(raw)) return `+${raw.slice(2)}`;
  if (/^\+\d{8,15}$/.test(raw)) return raw;
  return null;
}

const tekst = (max) => z.string().trim().max(max);

export const ansoegningSchema = z.object({
  firmanavn: tekst(120).min(2, "Skriv firmanavnet"),
  cvr: tekst(20),
  kontaktperson: tekst(120).min(2, "Skriv en kontaktperson"),
  email: z.string().trim().toLowerCase().max(200).email("Skriv en gyldig e-mail"),
  telefon: tekst(30).min(8, "Skriv et telefonnummer"),
  leveringsadresse: tekst(200).min(3, "Skriv leveringsadressen"),
  postnr: z.string().trim().regex(/^\d{4}$/, "Postnummeret skal være 4 cifre"),
  by: tekst(80).min(2, "Skriv byen"),
  kopper_pr_dag: z.enum(["under-50", "50-150", "150-300", "over-300"], { message: "Vælg antal kopper pr. dag" }),
  maskine: tekst(120).optional().default(""),
  // Afkrydsningsfeltet sendes kun, når det er krydset af.
  nyhedsbrev: z.preprocess((v) => v === true || v === "on" || v === "true" || v === "1", z.boolean()),
});

// ---------------------------------------------------------------- Ansøgning

function splitNavn(navn) {
  const dele = navn.trim().split(/\s+/);
  return { firstName: dele.length > 1 ? dele.slice(0, -1).join(" ") : dele[0], lastName: dele.length > 1 ? dele.at(-1) : "" };
}

function kundeMetafelter(v) {
  return [
    { namespace: "erhverv", key: "firmanavn", type: "single_line_text_field", value: v.firmanavn },
    { namespace: "erhverv", key: "cvr", type: "single_line_text_field", value: v.cvr },
    { namespace: "erhverv", key: "kontaktperson", type: "single_line_text_field", value: v.kontaktperson },
  ];
}

const FIND_KUNDE = `query($q: String!) { customers(first: 1, query: $q) { nodes { id tags } } }`;

async function findKunde(env, email) {
  const data = await adminGraphql(env, FIND_KUNDE, { q: `email:"${email.replace(/"/g, "")}"` });
  return data.customers.nodes[0] ?? null;
}

async function tilfoejTags(env, id, tags) {
  const data = await adminGraphql(env, `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id, tags });
  assertNoUserErrors(data.tagsAdd, "Kunne ikke sætte tags");
}

async function fjernTags(env, id, tags) {
  const data = await adminGraphql(env, `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id, tags });
  assertNoUserErrors(data.tagsRemove, "Kunne ikke fjerne tags");
}

async function saetMetafelter(env, ownerId, felter) {
  const data = await adminGraphql(
    env,
    `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
    { m: felter.map((f) => ({ ...f, ownerId })) },
  );
  assertNoUserErrors(data.metafieldsSet, "Kunne ikke gemme metafelter");
}

/**
 * Formularen fra butikken. Opretter (eller finder) kunden i Shopify med
 * tagget erhverv-afventer og gemmer virksomheden i Base44.
 */
export async function modtagAnsoegning(base44, env, input, { loggedInCustomerId } = {}) {
  const parsed = ansoegningSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, parsed.error.issues[0]?.message ?? "Tjek felterne");
  const v = parsed.data;
  const cvr = normaliserCvr(v.cvr);
  if (!cvr) throw new HttpError(422, "CVR-nummeret skal være 8 cifre");
  const telefon = normaliserTelefon(v.telefon);
  if (!telefon) throw new HttpError(422, "Telefonnummeret ser forkert ud");

  const db = base44.asServiceRole.entities.Virksomhed;
  const tidligere = await db.filter({ cvr }, "-created_date", 5);
  if (tidligere.some((r) => r.status === "afventer")) throw new HttpError(409, "Der er allerede oprettet en erhvervsaftale med dette CVR-nummer. Vi godkender den hurtigst muligt.");
  if (tidligere.some((r) => r.status === "godkendt")) throw new HttpError(409, "Virksomheden er allerede erhvervskunde. Log ind for at bestille.");

  const felter = { ...v, cvr, telefon };
  const tags = [TAG.erhverv, TAG.afventer];
  let kundeId = loggedInCustomerId ? `gid://shopify/Customer/${loggedInCustomerId}` : null;
  if (!kundeId) kundeId = (await findKunde(env, v.email))?.id ?? null;

  if (kundeId) {
    // Kunden findes. Navn og adresse lader vi stå; ejeren ser ansøgningen først.
    await fjernTags(env, kundeId, [TAG.afvist]);
    await tilfoejTags(env, kundeId, tags);
    await saetMetafelter(env, kundeId, kundeMetafelter(felter));
  } else {
    const { firstName, lastName } = splitNavn(v.kontaktperson);
    const kunde = {
      email: v.email,
      phone: telefon,
      firstName,
      lastName,
      tags,
      note: `Erhvervsansøgning: ${v.firmanavn}, CVR ${cvr}`,
      metafields: kundeMetafelter(felter),
    };
    // Kun et aktivt flueben giver markedsføringssamtykke. Feltet er ikke krydset af på forhånd.
    if (v.nyhedsbrev) kunde.emailMarketingConsent = { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" };
    const data = await adminGraphql(env, `mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`, { input: kunde });
    const fejl = data.customerCreate.userErrors ?? [];
    if (fejl.some((e) => String(e.field).includes("phone"))) {
      // Nummeret er allerede brugt af en anden kunde. Opret uden, så ansøgningen ikke går tabt.
      delete kunde.phone;
      const igen = await adminGraphql(env, `mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`, { input: kunde });
      kundeId = assertNoUserErrors(igen.customerCreate, "Kunne ikke oprette kunden").customer.id;
    } else {
      kundeId = assertNoUserErrors(data.customerCreate, "Kunne ikke oprette kunden").customer.id;
    }
    // Adressen er sin egen mutation i dette API. Fejler den, har ejeren den stadig i ansøgningen.
    await adminGraphql(
      env,
      `mutation($id: ID!, $a: MailingAddressInput!) { customerAddressCreate(customerId: $id, address: $a, setAsDefault: true) { userErrors { message } } }`,
      { id: kundeId, a: { company: v.firmanavn, address1: v.leveringsadresse, zip: v.postnr, city: v.by, countryCode: "DK", phone: telefon, firstName, lastName } },
    ).catch(() => null);
  }

  const post = await db.create({
    ...felter,
    status: "afventer",
    shopify_customer_id: kundeId,
    oprettet: new Date().toISOString(),
  });
  return { id: post.id };
}

// ---------------------------------------------------------------- Ejerens side

export async function listVirksomheder(base44, status) {
  const db = base44.asServiceRole.entities.Virksomhed;
  const filter = status && status !== "alle" ? { status } : {};
  return db.filter(filter, "-created_date", 500);
}

export async function hentVirksomhed(base44, id) {
  try {
    return await base44.asServiceRole.entities.Virksomhed.get(id);
  } catch (e) {
    if (e?.status === 404) throw new HttpError(404, "Ansøgningen findes ikke");
    throw e;
  }
}

async function butikInfo(env) {
  const data = await adminGraphql(env, `{ shop { name email primaryDomain { url } } }`);
  return { navn: data.shop.name, email: data.shop.email, url: data.shop.primaryDomain.url };
}

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Sender en mail gennem Base44. Til en adresse, der ikke er bruger af appen,
 * kræver Base44 betalt abonnement og eget domæne — derfor melder vi, om det
 * lykkedes, i stedet for at lade godkendelsen fejle.
 */
async function sendMail(base44, { to, subject, afsnit }) {
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#1C1A17;max-width:560px">${afsnit
    .map((a) => (a.link ? `<p><a href="${escapeHtml(a.link)}" style="color:#9A4421">${escapeHtml(a.tekst)}</a></p>` : `<p>${escapeHtml(a.tekst)}</p>`))
    .join("")}</div>`;
  const text = afsnit.map((a) => (a.link ? `${a.tekst}: ${a.link}` : a.tekst)).join("\n\n");
  try {
    await base44.asServiceRole.integrations.Core.SendEmail({ to, subject, html, text, from_name: "Café Costa", category: "transactional" });
    return { sendt: true };
  } catch (e) {
    return { sendt: false, fejl: String(e?.message ?? e).slice(0, 300) };
  }
}

export async function godkend(base44, env, id, prisniveau) {
  const niveau = Number(prisniveau);
  if (![1, 2, 3].includes(niveau)) throw new HttpError(422, "Vælg prisniveau 1, 2 eller 3");
  const v = await hentVirksomhed(base44, id);
  if (!v.shopify_customer_id) throw new HttpError(409, "Virksomheden har ingen kunde i Shopify");

  await fjernTags(env, v.shopify_customer_id, ALLE_STATUS_TAGS.filter((t) => t !== TAG.niveau(niveau)));
  await tilfoejTags(env, v.shopify_customer_id, [TAG.erhverv, TAG.godkendt, TAG.niveau(niveau)]);
  await saetMetafelter(env, v.shopify_customer_id, [{ namespace: "erhverv", key: "prisniveau", type: "number_integer", value: String(niveau) }]);

  const opdateret = await base44.asServiceRole.entities.Virksomhed.update(id, { status: "godkendt", prisniveau: niveau, godkendt_dato: new Date().toISOString() });

  const butik = await butikInfo(env);
  const satser = (await hentSatser(env)).satser;
  const mail = await sendMail(base44, {
    to: v.email,
    subject: `Velkommen som erhvervskunde hos ${butik.navn}`,
    afsnit: [
      { tekst: `Kære ${v.kontaktperson}` },
      { tekst: `${v.firmanavn} er nu godkendt som erhvervskunde. I får ${satser[niveau]} % på kaffen. Rabatten trækkes fra ved kassen, når I er logget ind.` },
      { tekst: "Log ind med denne e-mail for at se jeres aftale, bestille og finde fakturaer", link: `${butik.url}/pages/erhverv` },
      { tekst: "Venlig hilsen\nCafé Costa, Kalundborg" },
    ],
  });
  return { virksomhed: opdateret, mail };
}

export async function afvis(base44, env, id) {
  const v = await hentVirksomhed(base44, id);
  if (v.shopify_customer_id) {
    await fjernTags(env, v.shopify_customer_id, ALLE_STATUS_TAGS.filter((t) => t !== TAG.afvist));
    await tilfoejTags(env, v.shopify_customer_id, [TAG.afvist]);
  }
  const opdateret = await base44.asServiceRole.entities.Virksomhed.update(id, { status: "afvist" });
  const butik = await butikInfo(env);
  const mail = await sendMail(base44, {
    to: v.email,
    subject: `Jeres erhvervsaftale hos ${butik.navn}`,
    afsnit: [
      { tekst: `Kære ${v.kontaktperson}` },
      { tekst: `Tak for jeres interesse. Vi kan desværre ikke oprette ${v.firmanavn} som erhvervskunde lige nu. I er altid velkomne til at handle i webshoppen eller skrive til os, hvis I har spørgsmål.` },
      { tekst: "Venlig hilsen\nCafé Costa, Kalundborg" },
    ],
  });
  return { virksomhed: opdateret, mail };
}

/**
 * Sletter ansøgningen i Base44, f.eks. spam eller en test. Kunden i Shopify
 * røres ikke — den kan have ordrer — men mister sine erhvervs-tags.
 */
export async function slet(base44, env, id) {
  const v = await hentVirksomhed(base44, id);
  if (v.shopify_customer_id) {
    await fjernTags(env, v.shopify_customer_id, ALLE_STATUS_TAGS).catch(() => null);
  }
  await base44.asServiceRole.entities.Virksomhed.delete(id);
  return { slettet: id };
}

// ---------------------------------------------------------------- Risteplan

const DAG = 24 * 60 * 60 * 1000;

/** Mandag kl. 00 i dansk tid for ugen, der indeholder `dato`, plus `uger` uger. */
function ugeStart(dato, uger = 0) {
  const dk = new Date(dato.toLocaleString("en-US", { timeZone: "Europe/Copenhagen" }));
  const forskel = dato.getTime() - dk.getTime();
  const ugedag = (dk.getDay() + 6) % 7; // mandag = 0
  const mandag = new Date(dk.getFullYear(), dk.getMonth(), dk.getDate() - ugedag + uger * 7);
  return new Date(mandag.getTime() + forskel);
}

function plusInterval(dato, interval, antal) {
  const d = new Date(dato);
  if (interval === "DAY") d.setUTCDate(d.getUTCDate() + antal);
  else if (interval === "WEEK") d.setUTCDate(d.getUTCDate() + 7 * antal);
  else if (interval === "MONTH") d.setUTCMonth(d.getUTCMonth() + antal);
  else if (interval === "YEAR") d.setUTCFullYear(d.getUTCFullYear() + antal);
  else return null;
  return d;
}

/** Kg i en variant ud fra navnet: «1 kg» = 1, «Kasse 6 × 1 kg» = 6, «250 g» = 0,25. */
export function kgIVariant(navn) {
  const t = String(navn ?? "").toLowerCase().replace(",", ".");
  const vaegt = /(\d+(?:\.\d+)?)\s*(kg|g)\b/.exec(t);
  if (!vaegt) return null;
  const kg = vaegt[2] === "g" ? Number(vaegt[1]) / 1000 : Number(vaegt[1]);
  const antal = /(\d+)\s*[×x]\s*\d/.exec(t);
  return kg * (antal ? Number(antal[1]) : 1);
}

const ORDRER = `query($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt cancelledAt displayFulfillmentStatus tags
      customer { id displayName firma: metafield(namespace: "erhverv", key: "firmanavn") { value } }
      lineItems(first: 50) { nodes { title variantTitle quantity unfulfilledQuantity sellingPlan { name sellingPlanId } variant { id } product { id } } }
    }
  }
}`;

async function hentOrdrer(env, q) {
  const alle = [];
  let after = null;
  for (let side = 0; side < 10; side++) {
    const data = await adminGraphql(env, ORDRER, { q, after });
    alle.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return alle;
}

/**
 * Risteplan for én uge (mandag–søndag, dansk tid).
 * - Ventende: ordrer, der er kommet ind og ikke er sendt endnu.
 * - Forventede: faste leveringer, der falder i ugen, regnet ud fra den seneste
 *   ordre pr. kunde og kaffe plus abonnementets rytme. Shopify lader ikke appen
 *   læse abonnementerne direkte, så et opsagt eller sat-på-pause abonnement kan
 *   stå her, indtil det mangler en ordre.
 */
export async function risteplan(env, uger = 0) {
  const fra = ugeStart(new Date(), uger);
  const til = new Date(fra.getTime() + 7 * DAG);
  const historik = new Date(Date.now() - 400 * DAG).toISOString().slice(0, 10);

  const [ventendeOrdrer, abonnementsOrdrer] = await Promise.all([
    hentOrdrer(env, "fulfillment_status:unshipped OR fulfillment_status:partial"),
    hentOrdrer(env, `tag:Subscription created_at:>=${historik}`),
  ]);

  const firma = (o) => o.customer?.firma?.value || o.customer?.displayName || "Ukendt kunde";
  const linje = (o, l, antal, dato, type) => ({
    ordre: o.name,
    kunde: firma(o),
    dato,
    type,
    kaffe: l.title,
    variant: l.variantTitle,
    antal,
    kg: (kgIVariant(l.variantTitle) ?? 0) * antal,
    rytme: l.sellingPlan?.name ?? null,
  });

  // 1. Ordrer, der venter på at blive sendt (også dem fra tidligere uger).
  const ventende = [];
  for (const o of ventendeOrdrer) {
    if (o.cancelledAt) continue;
    for (const l of o.lineItems.nodes) {
      if (!l.unfulfilledQuantity) continue;
      ventende.push(linje(o, l, l.unfulfilledQuantity, o.createdAt, l.sellingPlan ? "fast" : "enkelt"));
    }
  }

  // 2. Seneste ordre pr. kunde, variant og rytme → næste leveringer.
  const seneste = new Map();
  for (const o of abonnementsOrdrer) {
    if (o.cancelledAt) continue;
    for (const l of o.lineItems.nodes) {
      if (!l.sellingPlan || !l.variant) continue;
      const noegle = `${o.customer?.id}|${l.variant.id}|${l.sellingPlan.sellingPlanId}`;
      const før = seneste.get(noegle);
      if (!før || new Date(o.createdAt) > new Date(før.o.createdAt)) seneste.set(noegle, { o, l });
    }
  }

  const planIds = [...new Set([...seneste.values()].map((x) => x.l.sellingPlan.sellingPlanId))];
  const rytmer = new Map();
  if (planIds.length) {
    const data = await adminGraphql(
      env,
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on SellingPlan { id deliveryPolicy { ... on SellingPlanRecurringDeliveryPolicy { interval intervalCount } } } } }`,
      { ids: planIds },
    );
    for (const n of data.nodes) if (n?.deliveryPolicy?.interval) rytmer.set(n.id, n.deliveryPolicy);
  }

  const forventede = [];
  for (const { o, l } of seneste.values()) {
    const rytme = rytmer.get(l.sellingPlan.sellingPlanId);
    if (!rytme) continue;
    let naeste = plusInterval(o.createdAt, rytme.interval, rytme.intervalCount);
    for (let i = 0; naeste && naeste < fra && i < 400; i++) naeste = plusInterval(naeste, rytme.interval, rytme.intervalCount);
    while (naeste && naeste < til) {
      forventede.push(linje(o, l, l.quantity, naeste.toISOString(), "forventet"));
      naeste = plusInterval(naeste, rytme.interval, rytme.intervalCount);
    }
  }
  forventede.sort((a, b) => a.dato.localeCompare(b.dato));

  // 3. Samlet pr. kaffe.
  const pr = new Map();
  for (const x of [...ventende, ...forventede]) {
    const r = pr.get(x.kaffe) ?? { kaffe: x.kaffe, kg: 0, ventendeKg: 0, forventetKg: 0, ukendt: 0 };
    if (!x.kg) r.ukendt += x.antal;
    r.kg += x.kg;
    if (x.type === "forventet") r.forventetKg += x.kg;
    else r.ventendeKg += x.kg;
    pr.set(x.kaffe, r);
  }
  const ialt = [...pr.values()].sort((a, b) => b.kg - a.kg);

  return { fra: fra.toISOString(), til: til.toISOString(), ventende, forventede, ialt };
}

// ---------------------------------------------------------------- Aftaler (fast levering)

const ABONNEMENTS_ORDRER = `query($q: String!, $after: String) {
  orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId name createdAt cancelledAt
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { id legacyResourceId displayName defaultEmailAddress { emailAddress } tags firma: metafield(namespace: "erhverv", key: "firmanavn") { value } }
      transactions(first: 5) { kind status paymentDetails { ... on CardPaymentDetails { number company } } }
      lineItems(first: 50) { nodes { title variantTitle quantity sellingPlan { name sellingPlanId } variant { id } } }
    }
  }
}`;

async function hentAbonnementsOrdrer(env, q) {
  const alle = [];
  let after = null;
  for (let side = 0; side < 10; side++) {
    const data = await adminGraphql(env, ABONNEMENTS_ORDRER, { q, after });
    alle.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return alle;
}

async function hentRytmer(env, planIds) {
  const rytmer = new Map();
  if (!planIds.length) return rytmer;
  const data = await adminGraphql(
    env,
    `query($ids: [ID!]!) { nodes(ids: $ids) { ... on SellingPlan { id name deliveryPolicy { ... on SellingPlanRecurringDeliveryPolicy { interval intervalCount } } } } }`,
    { ids: planIds },
  );
  for (const n of data.nodes) if (n?.deliveryPolicy?.interval) rytmer.set(n.id, n.deliveryPolicy);
  return rytmer;
}

/** «•••• 4242» ud fra ordrens betaling, hvis Shopify har kortet. */
function kortCifre(o) {
  for (const t of o.transactions ?? []) {
    const nr = t.paymentDetails?.number;
    if (nr) return { sidste4: String(nr).replace(/\D/g, "").slice(-4) || null, type: t.paymentDetails.company ?? null };
  }
  return null;
}

// Shopify Subscriptions prøver en fejlet trækning igen 3 gange over 7 dage
// (sat op i Shopify Subscriptions). Kommer der ikke en ny ordre til tiden,
// regner vi trækningen for fejlet.
const GENFORSOEG_DAGE = 7;

/**
 * Faste leveringer, regnet ud fra ordrer med Shopify Subscriptions' tag
 * «Subscription». Appen har bevidst ikke adgang til selve abonnementerne, så
 * næste trækning = seneste ordre + rytmen. En trækning, der er mere end et
 * døgn forsinket, vises som fejlet.
 */
export async function aftaler(env, { kundeId = null } = {}) {
  const historik = new Date(Date.now() - 400 * DAG).toISOString().slice(0, 10);
  const q = `tag:Subscription created_at:>=${historik}` + (kundeId ? ` customer_id:${String(kundeId).split("/").pop()}` : "");
  const ordrer = (await hentAbonnementsOrdrer(env, q)).filter((o) => !o.cancelledAt && o.customer);

  // Nyeste ordre pr. kunde og rytme (ordrerne kommer nyeste først).
  const grupper = new Map();
  for (const o of ordrer) {
    const planer = new Map();
    for (const l of o.lineItems.nodes) if (l.sellingPlan) planer.set(l.sellingPlan.sellingPlanId, l.sellingPlan.name);
    for (const [planId, planNavn] of planer) {
      const noegle = `${o.customer.id}|${planId}`;
      const g = grupper.get(noegle);
      if (!g) grupper.set(noegle, { o, planId, planNavn, antalOrdrer: 1, start: o.createdAt });
      else {
        g.antalOrdrer += 1;
        g.start = o.createdAt;
      }
    }
  }

  const rytmer = await hentRytmer(env, [...new Set([...grupper.values()].map((g) => g.planId))]);
  const nu = Date.now();
  const liste = [];
  for (const g of grupper.values()) {
    const { o } = g;
    const rytme = rytmer.get(g.planId);
    const naeste = rytme ? plusInterval(o.createdAt, rytme.interval, rytme.intervalCount) : null;
    const forsinket = naeste ? (nu - naeste.getTime()) / DAG : 0;
    let status = "aktiv";
    let note = null;
    if (forsinket > 1) {
      status = "fejlet";
      note = forsinket <= GENFORSOEG_DAGE + 1
        ? `Trækningen ${dkDato(naeste)} gik ikke igennem. Shopify prøver igen i op til ${GENFORSOEG_DAGE} dage og har mailet kunden om at opdatere kortet.`
        : `Ingen trækning siden ${dkDato(naeste)}. Kortet er måske ikke opdateret, eller aftalen er sat på pause eller opsagt.`;
    }
    const linjer = o.lineItems.nodes
      .filter((l) => l.sellingPlan?.sellingPlanId === g.planId)
      .map((l) => ({ kaffe: l.title, variant: l.variantTitle, antal: l.quantity }));
    liste.push({
      id: `${o.customer.legacyResourceId}-${g.planId.split("/").pop()}`,
      kunde: o.customer.firma?.value || o.customer.displayName,
      kontakt: o.customer.displayName,
      email: o.customer.defaultEmailAddress?.emailAddress ?? null,
      erhverv: (o.customer.tags ?? []).includes(TAG.godkendt),
      kundeId: o.customer.legacyResourceId,
      rytme: g.planNavn,
      naeste: naeste ? naeste.toISOString() : null,
      seneste: o.createdAt,
      start: g.start,
      antalOrdrer: g.antalOrdrer,
      beloeb: Number(o.totalPriceSet.shopMoney.amount),
      valuta: o.totalPriceSet.shopMoney.currencyCode,
      senesteOrdre: { navn: o.name, id: o.legacyResourceId },
      kort: kortCifre(o),
      linjer,
      status,
      note,
    });
  }
  liste.sort((a, b) => (a.status === b.status ? String(a.naeste).localeCompare(String(b.naeste)) : a.status === "fejlet" ? -1 : 1));
  return { aftaler: liste, genforsoegDage: GENFORSOEG_DAGE };
}

const dkDato = (d) => new Date(d).toLocaleDateString("da-DK", { day: "numeric", month: "long", timeZone: "Europe/Copenhagen" });

// ---------------------------------------------------------------- Rabatsatser

/**
 * Erhvervsrabatten er Shopifys almindelige automatiske rabatter — én pr.
 * niveau, der kun gælder for kundegruppen med tagget erhverv-niveau-X. Det
 * virker på alle Shopify-planer; appens egne funktioner kræver Shopify Plus.
 *
 * Satserne gemmes også på butikken (erhverv.niveauer), så portalen kan vise
 * prisen, og rabatternes og kundegruppernes id'er gemmes i erhverv.rabatter.
 */
const NIVEAUER = [1, 2, 3];
const rabatTitel = (n) => `Erhvervsrabat ${n}`;
const gruppeNavn = (n) => `Erhvervskunder rabat ${n}`;

// Fast levering: rabatten skal også gælde abonnementer og alle senere leveringer.
// recurringCycleLimit 0 betyder «uden grænse». Uden dette får kun første
// levering erhvervsprisen, og resten opkræves til listepris.
const rabatIndhold = (sats) => ({
  customerGets: {
    value: { percentage: sats / 100 },
    items: { all: true },
    appliesOnOneTimePurchase: true,
    appliesOnSubscription: true,
  },
  recurringCycleLimit: 0,
});

async function hentGemteRabatter(env) {
  const data = await adminGraphql(env, `{ shop { id satser: metafield(namespace: "erhverv", key: "niveauer") { jsonValue } rabatter: metafield(namespace: "erhverv", key: "rabatter") { jsonValue } } }`);
  return { shopId: data.shop.id, satser: data.shop.satser?.jsonValue ?? null, rabatter: data.shop.rabatter?.jsonValue ?? {} };
}

export async function hentSatser(env) {
  const { satser: gemt, rabatter } = await hentGemteRabatter(env);
  const satser = {};
  for (const n of NIVEAUER) satser[n] = Number(gemt?.[n] ?? STANDARD_SATSER[n]);

  const ids = NIVEAUER.map((n) => rabatter[n]?.rabat).filter(Boolean);
  let rabat = null;
  if (ids.length) {
    const r = await adminGraphql(env, `query($ids: [ID!]!) { nodes(ids: $ids) { ... on DiscountAutomaticNode { id automaticDiscount { ... on DiscountAutomaticBasic { status } } } } }`, { ids });
    const fundne = r.nodes.filter((x) => x?.id);
    const aktive = fundne.filter((x) => x.automaticDiscount?.status === "ACTIVE").length;
    if (fundne.length === NIVEAUER.length) rabat = { status: aktive === NIVEAUER.length ? "ACTIVE" : "DELVIS" };
  }
  return { satser, rabat, gemt: Boolean(gemt) };
}

const satsSchema = z.coerce.number().min(0).max(60);
export const satserSchema = z.object({ 1: satsSchema, 2: satsSchema, 3: satsSchema });

/** Kundegruppen for et niveau. Findes den (f.eks. efter en fejl), genbruges den. */
async function sikrGruppe(env, n, gemtId) {
  if (gemtId) {
    const d = await adminGraphql(env, `query($id: ID!) { segment(id: $id) { id } }`, { id: gemtId }).catch(() => null);
    if (d?.segment?.id) return d.segment.id;
  }
  const navn = gruppeNavn(n);
  const liste = await adminGraphql(env, `{ segments(first: 250) { nodes { id name } } }`);
  const findes = liste.segments.nodes.find((x) => x.name === navn);
  if (findes) return findes.id;
  const data = await adminGraphql(
    env,
    `mutation($name: String!, $query: String!) { segmentCreate(name: $name, query: $query) { segment { id } userErrors { field message } } }`,
    { name: navn, query: `customer_tags CONTAINS '${TAG.niveau(n)}'` },
  );
  return assertNoUserErrors(data.segmentCreate, "Kunne ikke oprette kundegruppen").segment.id;
}

/** Rabatten for et niveau: opdatér satsen, eller opret den, hvis den mangler. */
async function sikrRabat(env, n, sats, gruppeId, gemtId) {
  if (gemtId) {
    const d = await adminGraphql(
      env,
      `mutation($id: ID!, $d: DiscountAutomaticBasicInput!) { discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $d) { automaticDiscountNode { id } userErrors { field message } } }`,
      { id: gemtId, d: rabatIndhold(sats) },
    );
    const fejl = d.discountAutomaticBasicUpdate.userErrors ?? [];
    if (!fejl.length && d.discountAutomaticBasicUpdate.automaticDiscountNode?.id) return gemtId;
    // Rabatten er slettet i Shopify. Så laver vi den igen nedenfor.
  }
  const data = await adminGraphql(
    env,
    `mutation($d: DiscountAutomaticBasicInput!) { discountAutomaticBasicCreate(automaticBasicDiscount: $d) { automaticDiscountNode { id } userErrors { field message } } }`,
    {
      d: {
        title: rabatTitel(n),
        startsAt: new Date().toISOString(),
        context: { customerSegments: { add: [gruppeId] } },
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
        ...rabatIndhold(sats),
      },
    },
  );
  return assertNoUserErrors(data.discountAutomaticBasicCreate, `Kunne ikke oprette ${rabatTitel(n)}`).automaticDiscountNode.id;
}

export async function gemSatser(env, input) {
  const parsed = satserSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, "Satserne skal være mellem 0 og 60 %");
  const satser = parsed.data;
  const { shopId, rabatter: gemte } = await hentGemteRabatter(env);

  const rabatter = {};
  for (const n of NIVEAUER) {
    const gruppe = await sikrGruppe(env, n, gemte[n]?.gruppe);
    const rabat = await sikrRabat(env, n, satser[n], gruppe, gemte[n]?.rabat);
    rabatter[n] = { gruppe, rabat };
  }
  await saetMetafelter(env, shopId, [
    { namespace: "erhverv", key: "rabatter", type: "json", value: JSON.stringify(rabatter) },
    { namespace: "erhverv", key: "niveauer", type: "json", value: JSON.stringify(satser) },
  ]);
  return { satser, rabat: { status: "ACTIVE" }, gemt: true };
}
