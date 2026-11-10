import { createFileRoute } from "@tanstack/react-router";
import { adminPageResponse } from "@/lib/admin-page.server";

// Indstillingssiden med rabatsatserne for prisniveau 1–3.
export const Route = createFileRoute("/api/admin-indstillinger")({
  server: { handlers: { GET: async () => adminPageResponse("indstillinger") } },
});
