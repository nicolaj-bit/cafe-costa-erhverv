import { createFileRoute } from "@tanstack/react-router";
import { adminPageResponse } from "@/lib/admin-page.server";

// Fanen Kaffevogn: kalender over bookinger og lukkede dage.
export const Route = createFileRoute("/api/admin-kaffevogn")({
  server: { handlers: { GET: async () => adminPageResponse("kaffevogn") } },
});
