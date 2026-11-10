import { createFileRoute } from "@tanstack/react-router";
import { SKRIFTER } from "@/lib/admin-skrifter.server";

// Café Costas skrifter til ejerens app: /api/admin-skrift?f=costa-instrument-sans-400
// Samme filer som i temaet, så appen og webshoppen ser ens ud.
export const Route = createFileRoute("/api/admin-skrift")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const navn = new URL(request.url).searchParams.get("f") ?? "";
        const b64 = Object.hasOwn(SKRIFTER, navn) ? SKRIFTER[navn] : null;
        if (!b64) return new Response("Findes ikke", { status: 404 });
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return new Response(bytes, {
          headers: {
            "content-type": "font/woff2",
            "cache-control": "public, max-age=31536000, immutable",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});
