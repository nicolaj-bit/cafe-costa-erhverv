import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { HttpError, shopifyEnv, verifyAdminIdToken } from "@/lib/shopify.server";
import { annullerBooking, gemIndstillinger as gemKaffevognIndstillinger, kaffevognOversigt, lukDag } from "@/lib/kaffevogn.server";
import { aftaler, afvis, gemSatser, godkend, hentSatser, hentVirksomhed, listVirksomheder, risteplan, slet } from "@/lib/erhverv.server";

// Data til ejerens side i Shopify admin. Kalderen skal sende App Bridges
// ID token som Bearer — det er signeret med appens client secret og bevis på,
// at det er butikkens admin, der spørger.
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const kald = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), status: z.enum(["alle", "afventer", "godkendt", "afvist"]).default("alle") }),
  z.object({ action: z.literal("get"), id: z.string().min(1).max(64) }),
  z.object({ action: z.literal("godkend"), id: z.string().min(1).max(64), prisniveau: z.coerce.number().int().min(1).max(3) }),
  z.object({ action: z.literal("afvis"), id: z.string().min(1).max(64) }),
  z.object({ action: z.literal("slet"), id: z.string().min(1).max(64) }),
  z.object({ action: z.literal("satser") }),
  z.object({ action: z.literal("aftaler") }),
  z.object({ action: z.literal("kaffevogn"), maaned: z.string().regex(/^\d{4}-\d{2}$/) }),
  z.object({ action: z.literal("kaffevogn-luk"), dato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), luk: z.boolean() }),
  z.object({ action: z.literal("kaffevogn-annuller"), id: z.string().min(1).max(64) }),
  z.object({ action: z.literal("kaffevogn-indstillinger"), postnumre: z.array(z.string()).max(300), varsel_dage: z.coerce.number() }),
  z.object({ action: z.literal("risteplan"), uger: z.coerce.number().int().min(-4).max(8).default(0) }),
  z.object({ action: z.literal("gem-satser"), satser: z.record(z.string(), z.coerce.number()) }),
]);

export const Route = createFileRoute("/api/admin-data")({
  server: {
    handlers: {
      POST: async ({ request, context }) => {
        try {
          const env = shopifyEnv();
          const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
          await verifyAdminIdToken(token, env);
          const parsed = kald.safeParse(await request.json().catch(() => null));
          if (!parsed.success) throw new HttpError(400, "Ukendt handling");
          const b = parsed.data;
          const base44 = context.getBase44();
          switch (b.action) {
            case "list": return json({ virksomheder: await listVirksomheder(base44, b.status) });
            case "get": return json({ virksomhed: await hentVirksomhed(base44, b.id) });
            case "godkend": return json(await godkend(base44, env, b.id, b.prisniveau));
            case "afvis": return json(await afvis(base44, env, b.id));
            case "slet": return json(await slet(base44, env, b.id));
            case "satser": return json(await hentSatser(env));
            case "aftaler": return json(await aftaler(env));
            case "kaffevogn": return json(await kaffevognOversigt(base44, env, b.maaned));
            case "kaffevogn-luk": return json(await lukDag(base44, env, b.dato, b.luk));
            case "kaffevogn-annuller": return json(await annullerBooking(base44, env, b.id));
            case "kaffevogn-indstillinger": {
              await gemKaffevognIndstillinger(base44, env, { postnumre: b.postnumre, varsel_dage: b.varsel_dage });
              return json(await kaffevognOversigt(base44, env, new Date().toISOString().slice(0, 7)));
            }
            case "risteplan": return json(await risteplan(env, b.uger));
            case "gem-satser": return json(await gemSatser(env, b.satser));
          }
          throw new HttpError(400, "Ukendt handling");
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 500;
          return json({ fejl: String(e?.message ?? e) }, status);
        }
      },
    },
  },
});
