import { createFileRoute } from "@tanstack/react-router";
import { adminPageResponse } from "@/lib/admin-page.server";

// Gammel adresse. Risteplanen ligger nu under fanen Aftaler.
export const Route = createFileRoute("/api/admin-risteplan")({
  server: { handlers: { GET: async () => adminPageResponse("aftaler") } },
});
