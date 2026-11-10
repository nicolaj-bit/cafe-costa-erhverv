import { createFileRoute } from "@tanstack/react-router";
import { adminPageResponse } from "@/lib/admin-page.server";

// Appens forside i Shopify admin (application_url i shopify.app.toml).
// Siden selv indeholder ingen data; dem henter den fra /api/admin-data med ID token.
export const Route = createFileRoute("/api/admin")({
  server: { handlers: { GET: async () => adminPageResponse("ansoegninger") } },
});
