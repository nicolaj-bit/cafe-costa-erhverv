import { createFileRoute } from "@tanstack/react-router";
import { adminPageResponse } from "@/lib/admin-page.server";

// Ugens risteplan: hvad der skal ristes og sendes.
export const Route = createFileRoute("/api/admin-risteplan")({
  server: { handlers: { GET: async () => adminPageResponse("risteplan") } },
});
