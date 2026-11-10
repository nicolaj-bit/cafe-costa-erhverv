import { createFileRoute } from "@tanstack/react-router";
import { HttpError, shopifyEnv, verifyWebhook } from "@/lib/shopify.server";
import { ordreAnnulleret, ordreOprettet, refusion } from "@/lib/kaffevogn.server";

// Webhooks fra Shopify (abonnementerne står i shopify.app.toml). Signaturen
// tjekkes, før kroppen læses som JSON. Svarer vi ikke 200, prøver Shopify igen.
const HANDLINGER = {
  "orders/create": ordreOprettet,
  "orders/cancelled": ordreAnnulleret,
  "refunds/create": refusion,
};

export const Route = createFileRoute("/api/webhooks")({
  server: {
    handlers: {
      POST: async ({ request, context }) => {
        try {
          const env = shopifyEnv();
          const raw = await request.text();
          const { topic } = await verifyWebhook(raw, request.headers, env);
          const handling = HANDLINGER[topic];
          if (!handling) return new Response("ok");
          await handling(context.getBase44(), env, JSON.parse(raw));
          return new Response("ok");
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 500;
          return new Response(String(e?.message ?? e), { status });
        }
      },
    },
  },
});
