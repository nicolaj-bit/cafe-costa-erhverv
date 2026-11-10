// Booking af kaffevognen. Kunden vælger dag og betaler selv i den almindelige
// checkout; her holdes styr på, hvilke dage der er optaget.
//
// Flowet:
//   1. Kalenderen i butikken spørger app proxy'en om optagede dage.
//   2. «Læg i kurv» reserverer dagen i 15 minutter (status reserveret).
//   3. Webhook orders/create sætter bookingen til betalt.
//   4. Annullering eller refusion frigiver dagen igen.
// Optagede, reserverede og lukkede dage skrives også til shop-metafeltet
// costa.kaffevogn_optaget, så temaet kan læse dem.
//
// Shopify Plus er ikke en mulighed, så der er ingen valideringsfunktion i
// checkout. Reservationen er spærringen, og en dobbeltbooking, der alligevel
// slipper igennem, markeres på bookingen, så ejeren kan refundere den ene.
import { z } from "zod";
import { HttpError, adminGraphql, assertNoUserErrors } from "@/lib/shopify.server";

const RESERVATION_MINUTTER = 15;
const TELEFON = "52 76 04 60";
export const UDEN_FOR_OMRAADE = `Ring på ${TELEFON}, så finder vi en løsning`;

// Foreløbige værdier. Ejeren retter dem under fanen Kaffevogn.
export const STANDARD_INDSTILLINGER = {
  // Kalundborg Kommune. Udfyldes af ejeren.
  postnumre: ["4400", "4450", "4460", "4470", "4480", "4490", "4591", "4592", "4593"],
  varsel_dage: 7,
  lukket: [],
};

// ---------------------------------------------------------------- Datoer

const DATO = /^\d{4}-\d{2}-\d{2}$/;

/** I dag i dansk tid som YYYY-MM-DD. */
export function idag(nu = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(nu);
}

export function plusDage(dato, dage) {
  const d = new Date(`${dato}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dage);
  return d.toISOString().slice(0, 10);
}

/** Første dag, der kan bookes, når der kræves `varsel` dages varsel. */
export const foersteDag = (varsel, nu = new Date()) => plusDage(idag(nu), Number(varsel) || 0);

const dkDato = (dato) =>
  new Date(`${dato}T12:00:00Z`).toLocaleDateString("da-DK", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// ---------------------------------------------------------------- Indstillinger

const INDSTILLINGER = `{ shop { id ind: metafield(namespace: "costa", key: "kaffevogn_indstillinger") { jsonValue } } }`;

export async function hentIndstillinger(env) {
  const data = await adminGraphql(env, INDSTILLINGER);
  const gemt = data.shop.ind?.jsonValue ?? {};
  return {
    shopId: data.shop.id,
    postnumre: Array.isArray(gemt.postnumre) ? gemt.postnumre.map(String) : STANDARD_INDSTILLINGER.postnumre,
    varsel_dage: Number.isFinite(Number(gemt.varsel_dage)) ? Number(gemt.varsel_dage) : STANDARD_INDSTILLINGER.varsel_dage,
    lukket: Array.isArray(gemt.lukket) ? gemt.lukket.filter((d) => DATO.test(d)) : [],
  };
}

async function skrivMetafelt(env, ownerId, key, value) {
  const data = await adminGraphql(
    env,
    `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
    { m: [{ ownerId, namespace: "costa", key, type: "json", value: JSON.stringify(value) }] },
  );
  assertNoUserErrors(data.metafieldsSet, "Kunne ikke gemme i Shopify");
}

async function gemIndstillingerRaa(env, ind) {
  const { shopId, ...vaerdier } = ind;
  await skrivMetafelt(env, shopId, "kaffevogn_indstillinger", {
    postnumre: vaerdier.postnumre,
    varsel_dage: vaerdier.varsel_dage,
    lukket: [...new Set(vaerdier.lukket)].sort(),
  });
}

export const indstillingerSchema = z.object({
  postnumre: z.array(z.string().trim().regex(/^\d{4}$/, "Postnumre skal være 4 cifre")).max(300),
  varsel_dage: z.coerce.number().int().min(0).max(365),
});

export async function gemIndstillinger(base44, env, input) {
  const parsed = indstillingerSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, parsed.error.issues[0]?.message ?? "Tjek indstillingerne");
  const ind = await hentIndstillinger(env);
  await gemIndstillingerRaa(env, { ...ind, ...parsed.data, postnumre: [...new Set(parsed.data.postnumre)].sort() });
  return opdaterOptaget(base44, env);
}

// ---------------------------------------------------------------- Bookinger

const db = (base44) => base44.asServiceRole.entities.Booking;

/**
 * Bookinger, der holder en dag: betalte og reservationer, der ikke er udløbet.
 * Udløbne reservationer annulleres her — så ryddes de automatisk, hver gang
 * nogen ser på kalenderen.
 */
async function aktiveBookinger(base44, nu = Date.now()) {
  const [reserveret, betalt] = await Promise.all([
    db(base44).filter({ status: "reserveret" }, "created_date", 500),
    db(base44).filter({ status: "betalt" }, "dato", 1000),
  ]);
  const gyldige = [];
  for (const b of reserveret) {
    if (b.reserveret_til && new Date(b.reserveret_til).getTime() > nu) gyldige.push(b);
    else await db(base44).update(b.id, { status: "annulleret", note: "Reservationen udløb uden betaling" });
  }
  return [...betalt, ...gyldige];
}

/** Skriver optagede, reserverede og lukkede dage til costa.kaffevogn_optaget. */
export async function opdaterOptaget(base44, env) {
  const [ind, aktive] = await Promise.all([hentIndstillinger(env), aktiveBookinger(base44)]);
  const fra = idag();
  const fremtid = (d) => d >= fra;
  const vaerdi = {
    optaget: [...new Set(aktive.filter((b) => b.status === "betalt").map((b) => b.dato))].filter(fremtid).sort(),
    reserveret: [...new Set(aktive.filter((b) => b.status === "reserveret").map((b) => b.dato))].filter(fremtid).sort(),
    lukket: ind.lukket.filter(fremtid).sort(),
    foerste_dag: foersteDag(ind.varsel_dage),
    opdateret: new Date().toISOString(),
  };
  await skrivMetafelt(env, ind.shopId, "kaffevogn_optaget", vaerdi);
  return { ...vaerdi, ind, aktive };
}

/** Til kalenderen i butikken. Viser kun, at en dag er optaget — ikke hvorfor. */
export async function kalender(base44, env) {
  const o = await opdaterOptaget(base44, env);
  return {
    optaget: [...new Set([...o.optaget, ...o.reserveret, ...o.lukket])].sort(),
    foerste_dag: o.foerste_dag,
  };
}

const tekst = (max) => z.string().trim().max(max);

export const reservationSchema = z.object({
  dato: z.string().regex(DATO, "Vælg en dag i kalenderen"),
  variant_id: z.string().regex(/^\d+$/, "Vælg hvor længe"),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Vælg et starttidspunkt"),
  gaester: z.coerce.number().int().min(1, "Skriv antal gæster").max(5000),
  adresse: tekst(200).min(3, "Skriv adressen"),
  postnr: z.string().trim().regex(/^\d{4}$/, "Postnummeret skal være 4 cifre"),
  by: tekst(80).min(2, "Skriv byen"),
  kontakt: tekst(120).min(2, "Skriv en kontaktperson"),
  telefon: tekst(30).min(8, "Skriv et telefonnummer"),
  placering: tekst(500).optional().default(""),
  // En tidligere reservation fra samme kunde, der skal erstattes (f.eks. ny dag).
  erstat: z.string().max(64).optional(),
});

async function hentVariant(env, variantId) {
  const data = await adminGraphql(
    env,
    `query($id: ID!) { productVariant(id: $id) { id title price product { handle productType } } }`,
    { id: `gid://shopify/ProductVariant/${variantId}` },
  );
  const v = data.productVariant;
  if (!v || v.product?.productType !== "Kaffevogn") throw new HttpError(422, "Vælg hvor længe");
  return v;
}

/**
 * «Læg i kurv»: tjekker dagen og postnummeret og holder dagen i 15 minutter.
 * Kunden får bookingens id med i kurven, så ordren kan finde den igen.
 */
export async function reserver(base44, env, input) {
  const parsed = reservationSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, parsed.error.issues[0]?.message ?? "Tjek felterne");
  const r = parsed.data;
  const ind = await hentIndstillinger(env);

  if (!ind.postnumre.includes(r.postnr)) throw new HttpError(422, UDEN_FOR_OMRAADE);
  if (r.dato < foersteDag(ind.varsel_dage)) {
    throw new HttpError(422, ind.varsel_dage > 0 ? `Kaffevognen skal bookes mindst ${ind.varsel_dage} dage før. ${UDEN_FOR_OMRAADE}.` : "Dagen er overstået. Vælg en anden dag.");
  }
  if (ind.lukket.includes(r.dato)) throw new HttpError(409, "Kaffevognen er ikke ledig den dag. Vælg en anden dag.");

  const variant = await hentVariant(env, r.variant_id);
  if (!(Number(variant.price) > 0)) throw new HttpError(409, `Kaffevognen kan ikke bookes online endnu. ${UDEN_FOR_OMRAADE}.`);

  // Kundens egen tidligere reservation frigives først, så den ikke spærrer.
  if (r.erstat) {
    const gammel = await db(base44).get(r.erstat).catch(() => null);
    if (gammel?.status === "reserveret") await db(base44).update(gammel.id, { status: "annulleret", note: "Erstattet af en ny reservation" });
  }

  const optagetAfAndre = (aktive) => aktive.filter((b) => b.dato === r.dato);
  if (optagetAfAndre(await aktiveBookinger(base44)).length) {
    throw new HttpError(409, "Dagen er desværre lige blevet booket. Vælg en anden dag.");
  }

  const reserveretTil = new Date(Date.now() + RESERVATION_MINUTTER * 60 * 1000).toISOString();
  const booking = await db(base44).create({
    dato: r.dato,
    variant: variant.title,
    variant_id: r.variant_id,
    start: r.start,
    gaester: r.gaester,
    adresse: r.adresse,
    postnr: r.postnr,
    by: r.by,
    kontakt: r.kontakt,
    telefon: r.telefon,
    placering: r.placering || null,
    status: "reserveret",
    reserveret_til: reserveretTil,
  });

  // To kunder, der trykker samtidig: den, der kom først, beholder dagen.
  const samme = optagetAfAndre(await aktiveBookinger(base44)).sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id)));
  if (samme[0]?.id !== booking.id) {
    await db(base44).update(booking.id, { status: "annulleret", note: "En anden nåede at reservere dagen først" });
    throw new HttpError(409, "Dagen er desværre lige blevet booket. Vælg en anden dag.");
  }

  await opdaterOptaget(base44, env);
  return {
    id: booking.id,
    reserveret_til: reserveretTil,
    variant: variant.title,
    dato_tekst: dkDato(r.dato),
  };
}

// ---------------------------------------------------------------- Webhooks

/** Linjeegenskaber fra en REST-ordre som { navn: værdi }. */
const egenskaber = (linje) => Object.fromEntries((linje?.properties ?? []).map((p) => [p.name, p.value]));

/** orders/create: bookingen er betalt, og reservationen fjernes. */
export async function ordreOprettet(base44, env, ordre) {
  let fundet = 0;
  for (const linje of ordre.line_items ?? []) {
    const e = egenskaber(linje);
    if (!e._booking && !e._dato) continue;
    fundet++;
    const booking = e._booking ? await db(base44).get(e._booking).catch(() => null) : null;
    const dato = booking?.dato ?? e._dato;

    // Er dagen allerede betalt af en anden ordre, skal ejeren refundere den ene.
    const andre = (await db(base44).filter({ status: "betalt", dato }, "created_date", 20)).filter((b) => b.id !== booking?.id && b.ordre_id !== String(ordre.id));
    const noter = [];
    if (andre.length) noter.push(`Dobbeltbooking: dagen er også betalt af ordre ${andre.map((b) => b.ordre_navn || b.ordre_id).join(", ")}. Ring til kunden, og refundér den ene.`);
    if (booking?.status === "annulleret") noter.push("Reservationen var udløbet, da der blev betalt.");
    if (!booking) noter.push("Booket uden om kalenderen. Tjek dagen og adressen.");

    const felter = {
      status: "betalt",
      ordre_id: String(ordre.id),
      ordre_navn: ordre.name ?? null,
      email: ordre.email ?? ordre.contact_email ?? null,
      reserveret_til: null,
      note: noter.join(" ") || null,
      // Kortet med en prik er en fil, kunden har lagt ved i kurven. Shopify gemmer den.
      ...(e.Kort ? { kort_url: String(e.Kort) } : {}),
    };
    if (booking) await db(base44).update(booking.id, felter);
    else {
      await db(base44).create({
        ...felter,
        dato,
        variant: linje.variant_title ?? null,
        variant_id: linje.variant_id ? String(linje.variant_id) : null,
        start: e.Start ?? null,
        gaester: Number(e["Gæster"]) || null,
        adresse: e.Adresse ?? null,
        kontakt: e.Kontakt ?? null,
        telefon: e.Telefon ?? null,
        placering: e.Placering ?? null,
      });
    }
  }
  if (fundet) await opdaterOptaget(base44, env);
  return { bookinger: fundet };
}

async function frigiv(base44, env, ordreId, note, kunBookinger = null) {
  const bookinger = await db(base44).filter({ ordre_id: String(ordreId) }, "dato", 20);
  let frigivet = 0;
  for (const b of bookinger) {
    if (b.status === "annulleret") continue;
    if (kunBookinger && !kunBookinger.includes(b.id) && !kunBookinger.includes(b.dato)) continue;
    await db(base44).update(b.id, { status: "annulleret", note });
    frigivet++;
  }
  if (frigivet) await opdaterOptaget(base44, env);
  return { frigivet };
}

/** orders/cancelled: dagen frigives. */
export const ordreAnnulleret = (base44, env, ordre) => frigiv(base44, env, ordre.id, "Ordren er annulleret. Dagen er frigivet.");

/** refunds/create: kun hvis selve kaffevognen er refunderet, frigives dagen. */
export async function refusion(base44, env, refusion) {
  const noegler = [];
  for (const r of refusion.refund_line_items ?? []) {
    const e = egenskaber(r.line_item);
    if (e._booking) noegler.push(e._booking);
    if (e._dato) noegler.push(e._dato);
  }
  if (!noegler.length) return { frigivet: 0 };
  return frigiv(base44, env, refusion.order_id, "Kaffevognen er refunderet. Dagen er frigivet.", noegler);
}

// ---------------------------------------------------------------- Ejerens side

export async function kaffevognOversigt(base44, env, maaned) {
  if (!/^\d{4}-\d{2}$/.test(maaned)) throw new HttpError(422, "Ukendt måned");
  const o = await opdaterOptaget(base44, env);
  const alle = await db(base44).filter({}, "dato", 1000);
  const bookinger = alle
    .filter((b) => String(b.dato).startsWith(maaned) && (b.status !== "annulleret" || b.ordre_id))
    .map((b) => ({ ...b }));
  return {
    maaned,
    bookinger,
    lukket: o.ind.lukket.filter((d) => d.startsWith(maaned)),
    indstillinger: { postnumre: o.ind.postnumre, varsel_dage: o.ind.varsel_dage },
    idag: idag(),
  };
}

export async function lukDag(base44, env, dato, luk) {
  if (!DATO.test(dato)) throw new HttpError(422, "Ukendt dag");
  const ind = await hentIndstillinger(env);
  const lukket = luk ? [...ind.lukket, dato] : ind.lukket.filter((d) => d !== dato);
  await gemIndstillingerRaa(env, { ...ind, lukket });
  await opdaterOptaget(base44, env);
  const booket = (await db(base44).filter({ dato }, "created_date", 20)).some((b) => b.status === "betalt");
  return { dato, lukket: luk, advarsel: luk && booket ? "Dagen har en betalt booking. Den er stadig gyldig — ring til kunden, hvis den skal flyttes." : null };
}

/** Ejeren frigiver en dag. En betalt ordre skal stadig refunderes i Shopify. */
export async function annullerBooking(base44, env, id) {
  const b = await db(base44).get(id).catch(() => null);
  if (!b) throw new HttpError(404, "Bookingen findes ikke");
  await db(base44).update(id, { status: "annulleret", note: "Annulleret af ejeren. Dagen er frigivet." });
  await opdaterOptaget(base44, env);
  return { id, ordre_id: b.ordre_id ?? null };
}
