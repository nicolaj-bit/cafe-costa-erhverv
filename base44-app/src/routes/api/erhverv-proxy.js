import { createFileRoute } from "@tanstack/react-router";
import { HttpError, shopifyEnv, verifyProxySignature } from "@/lib/shopify.server";
import { modtagAnsoegning } from "@/lib/erhverv.server";

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
