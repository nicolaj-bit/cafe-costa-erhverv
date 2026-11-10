import { createFileRoute } from "@tanstack/react-router";
import { adminPageResponse } from "@/lib/admin-page.server";

// Fanen Aftaler: faste leveringer og ugens risteplan.
export const Route = createFileRoute("/api/admin-aftaler")({
  server: { handlers: { GET: async () => adminPageResponse("aftaler") } },
});
