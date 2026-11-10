import { createFileRoute } from "@tanstack/react-router";
import { adminPageResponse } from "@/lib/admin-page.server";

// Fanen Ansøgninger. Samme side som forsiden, men med sin egen plads i menuen.
export const Route = createFileRoute("/api/admin-ansoegninger")({
  server: { handlers: { GET: async () => adminPageResponse("ansoegninger") } },
});
