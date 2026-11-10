import { createFileRoute } from "@tanstack/react-router";
import { HttpError, shopifyEnv, verifyProxySignature } from "@/lib/shopify.server";
import { aftaler, modtagAnsoegning } from "@/lib/erhverv.server";

// Butikkens ansøgningsformular sender hertil gennem Shopifys app proxy:
// /apps/erhverv i butikken → /api/erhverv-proxy her. Kun Shopify kan lave
// signaturen på adressen, så en ukendt afsender bliver afvist, før vi rører data.
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function laesFelter(request) {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return request.json();
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

export const Route = createFileRoute("/api/erhverv-proxy")({
  server: {
    handlers: {
      // Portalens «Min aftale»: kundens egne faste leveringer. Shopify sætter
      // logged_in_customer_id i den signerede adresse, så kunden kan kun se sine egne.
      GET: async ({ request }) => {
        try {
          const env = shopifyEnv();
          const { loggedInCustomerId } = await verifyProxySignature(request.url, env);
          if (!loggedInCustomerId) throw new HttpError(401, "Log ind for at se jeres aftale");
          const { aftaler: liste } = await aftaler(env, { kundeId: loggedInCustomerId });
          // Kun det, kunden skal se. Ingen interne noter eller e-mails.
          const til = liste.map((a) => ({
            rytme: a.rytme,
            naeste: a.naeste,
            beloeb: a.beloeb,
            valuta: a.valuta,
            kort: a.kort,
            linjer: a.linjer,
            fejlet: a.status === "fejlet",
          }));
          return json({ ok: true, aftaler: til });
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 500;
          return json({ ok: false, fejl: status === 500 ? "Kunne ikke hente aftalen lige nu." : e.message }, status);
        }
      },
      POST: async ({ request, context }) => {
        try {
          const env = shopifyEnv();
          const { loggedInCustomerId } = await verifyProxySignature(request.url, env);
          const felter = await laesFelter(request);
          await modtagAnsoegning(context.getBase44(), env, felter, { loggedInCustomerId });
          return json({ ok: true });
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 500;
          // Ukendte fejl vises ikke i detaljer for kunden.
          const besked = status === 500 ? "Noget gik galt. Prøv igen, eller ring til os." : e.message;
          return json({ ok: false, fejl: besked }, status);
        }
      },
    },
  },
});
