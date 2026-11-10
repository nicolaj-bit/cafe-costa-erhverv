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
const RABAT_TITEL = "Erhvervspriser";
const FUNKTION = "erhverv-rabat";
// App-ejet navnerum: kun denne app kan skrive det. Funktionen læser samme sted.
const RABAT_NAVNERUM = "$app:erhverv";

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

// ---------------------------------------------------------------- Rabatsatser

/**
 * Satserne gemmes to steder i Shopify: på rabatten, hvor discount-funktionen
 * læser dem, og på butikken, hvor portalen i temaet viser erhvervsprisen.
 * Rabattens id gemmes også på butikken, så vi kan finde den igen.
 */
export async function hentSatser(env) {
  const data = await adminGraphql(env, `{ shop { satser: metafield(namespace: "erhverv", key: "niveauer") { jsonValue } rabat: metafield(namespace: "erhverv", key: "rabat_id") { value } } }`);
  const gemt = data.shop.satser?.jsonValue ?? {};
  const satser = { 1: Number(gemt[1] ?? STANDARD_SATSER[1]), 2: Number(gemt[2] ?? STANDARD_SATSER[2]), 3: Number(gemt[3] ?? STANDARD_SATSER[3]) };
  let rabat = null;
  const rabatId = data.shop.rabat?.value;
  if (rabatId) {
    const r = await adminGraphql(env, `query($id: ID!) { node(id: $id) { ... on DiscountAutomaticNode { id automaticDiscount { ... on DiscountAutomaticApp { title status } } } } }`, { id: rabatId });
    if (r.node?.id) rabat = { id: r.node.id, titel: r.node.automaticDiscount?.title, status: r.node.automaticDiscount?.status };
  }
  return { satser, rabat, gemt: Boolean(data.shop.satser) };
}

const satsSchema = z.coerce.number().min(0).max(60);
export const satserSchema = z.object({ 1: satsSchema, 2: satsSchema, 3: satsSchema });

export async function gemSatser(env, input) {
  const parsed = satserSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, "Satserne skal være mellem 0 og 60 %");
  const satser = parsed.data;
  const config = JSON.stringify({ satser });

  const shopData = await adminGraphql(env, `{ shop { id } }`);
  const shopId = shopData.shop.id;
  let { rabat } = await hentSatser(env);

  if (!rabat) {
    const data = await adminGraphql(
      env,
      `mutation($d: DiscountAutomaticAppInput!) { discountAutomaticAppCreate(automaticAppDiscount: $d) { automaticAppDiscount { discountId title status } userErrors { field message } } }`,
      {
        d: {
          title: RABAT_TITEL,
          functionHandle: FUNKTION,
          discountClasses: ["PRODUCT"],
          startsAt: new Date().toISOString(),
          combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
          metafields: [{ namespace: RABAT_NAVNERUM, key: "config", type: "json", value: config }],
        },
      },
    );
    const res = assertNoUserErrors(data.discountAutomaticAppCreate, "Kunne ikke oprette rabatten");
    rabat = { id: res.automaticAppDiscount.discountId, titel: res.automaticAppDiscount.title, status: res.automaticAppDiscount.status };
    await saetMetafelter(env, shopId, [{ namespace: "erhverv", key: "rabat_id", type: "single_line_text_field", value: rabat.id }]);
  } else {
    await saetMetafelter(env, rabat.id, [{ namespace: RABAT_NAVNERUM, key: "config", type: "json", value: config }]);
  }
  await saetMetafelter(env, shopId, [{ namespace: "erhverv", key: "niveauer", type: "json", value: JSON.stringify(satser) }]);
  return { satser, rabat, gemt: true };
}
