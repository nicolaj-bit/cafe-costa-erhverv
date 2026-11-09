// Forbindelsen til Shopify: hemmeligheder, adgangstoken og kontrol af de
// signaturer, Shopify sætter på kald fra admin og fra butikkens app proxy.
// Kun serverkode — filnavnet .server.js holder den ude af browseren.
import { secrets } from "base44:runtime";

export const API_VERSION = "2026-04";

/** Hemmelighederne sættes i Base44 under Dashboard → Secrets. */
export function shopifyEnv() {
  const store = String(secrets.get("SHOPIFY_STORE_DOMAIN") ?? "").trim().toLowerCase();
  const clientId = String(secrets.get("SHOPIFY_CLIENT_ID") ?? "").trim();
  const clientSecret = String(secrets.get("SHOPIFY_CLIENT_SECRET") ?? "").trim();
  const missing = [
    !store && "SHOPIFY_STORE_DOMAIN",
    !clientId && "SHOPIFY_CLIENT_ID",
    !clientSecret && "SHOPIFY_CLIENT_SECRET",
  ].filter(Boolean);
  if (missing.length) throw new HttpError(500, `Mangler hemmeligheder i Base44: ${missing.join(", ")}`);
  return { store, clientId, clientSecret };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const enc = new TextEncoder();

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function base64UrlToBytes(input) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Sammenligner to strenge uden at afsløre, hvor langt de stemmer overens. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * ID token fra App Bridge, når ejeren har appen åben i Shopify admin.
 * Signeret med appens client secret (HS256). `aud` skal være appens client id,
 * `dest` butikken og `iss` butikkens /admin — ellers er det ikke admin, der kalder.
 * https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens
 */
export async function verifyAdminIdToken(token, env) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new HttpError(401, "Mangler gyldigt token fra Shopify admin");
  const [h, p, s] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(h)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(p)));
  } catch {
    throw new HttpError(401, "Kan ikke læse tokenet");
  }
  if (header?.alg !== "HS256") throw new HttpError(401, "Uventet signaturtype");
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.clientSecret, "verify"), base64UrlToBytes(s), enc.encode(`${h}.${p}`));
  if (!ok) throw new HttpError(401, "Forkert signatur");

  const now = Math.floor(Date.now() / 1000);
  const leeway = 10;
  if (typeof payload.exp !== "number" || payload.exp + leeway < now) throw new HttpError(401, "Tokenet er udløbet");
  if (typeof payload.nbf === "number" && payload.nbf - leeway > now) throw new HttpError(401, "Tokenet er ikke gyldigt endnu");
  if (payload.aud !== env.clientId) throw new HttpError(401, "Tokenet er til en anden app");
  const host = (v) => String(v ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (host(payload.dest) !== env.store) throw new HttpError(401, "Tokenet er til en anden butik");
  let iss;
  try {
    iss = new URL(String(payload.iss ?? ""));
  } catch {
    throw new HttpError(401, "Ikke et token fra Shopify admin");
  }
  if (iss.hostname.toLowerCase() !== env.store || !/^\/admin\/?$/.test(iss.pathname)) {
    throw new HttpError(401, "Ikke et token fra Shopify admin");
  }
  return payload;
}

/**
 * Kald gennem butikkens app proxy (/apps/erhverv). Shopify lægger `signature`
 * på adressen: HMAC-SHA256 i hex over de øvrige parametre, sorteret og sat
 * sammen som `navn=værdi` uden skilletegn. Parametre med flere værdier
 * sættes sammen med komma.
 * https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 */
export async function verifyProxySignature(url, env) {
  const params = new URL(url).searchParams;
  const signature = params.get("signature") ?? "";
  const grouped = new Map();
  for (const [k, v] of params) {
    if (k === "signature") continue;
    grouped.set(k, [...(grouped.get(k) ?? []), v]);
  }
  const message = [...grouped.entries()]
    .map(([k, v]) => `${k}=${v.join(",")}`)
    .sort()
    .join("");
  const expected = toHex(await crypto.subtle.sign("HMAC", await hmacKey(env.clientSecret, "sign"), enc.encode(message)));
  if (!signature || !safeEqual(expected, signature)) throw new HttpError(401, "Forkert signatur fra app proxy");
  if (String(params.get("shop") ?? "").toLowerCase() !== env.store) throw new HttpError(401, "Forkert butik");
  const ts = Number(params.get("timestamp"));
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) throw new HttpError(401, "Forespørgslen er for gammel");
  return {
    shop: env.store,
    loggedInCustomerId: params.get("logged_in_customer_id") || null,
  };
}

// Adgangstoken til Admin API'et. Appen og butikken ligger i samme organisation
// i Dev Dashboard, så appen kan selv hente et token med client credentials —
// der skal ikke gemmes noget. Tokenet gælder ca. et døgn; vi holder det i
// hukommelsen, så længe arbejderen lever, og henter nyt ved behov.
let cached = null;

async function accessToken(env) {
  if (cached && cached.store === env.store && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await fetch(`https://${env.store}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: env.clientId, client_secret: env.clientSecret }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    throw new HttpError(502, `Kunne ikke hente token fra Shopify (HTTP ${res.status}): ${body?.error_description ?? body?.error ?? "intet svar"}`);
  }
  cached = { store: env.store, token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return cached.token;
}

/** GraphQL mod Admin API'et. Fejl fra `userErrors` håndteres af den, der kalder. */
export async function adminGraphql(env, query, variables = {}) {
  const res = await fetch(`https://${env.store}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await accessToken(env) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => null);
  if (res.status === 401) cached = null;
  if (!res.ok || !body || body.errors) {
    throw new HttpError(502, `Shopify svarede med fejl (HTTP ${res.status}): ${JSON.stringify(body?.errors ?? body).slice(0, 500)}`);
  }
  return body.data;
}

/** Kaster, hvis en mutation kom tilbage med userErrors. */
export function assertNoUserErrors(result, what) {
  const errors = result?.userErrors ?? [];
  if (errors.length) throw new HttpError(422, `${what}: ${errors.map((e) => e.message).join("; ")}`);
  return result;
}
