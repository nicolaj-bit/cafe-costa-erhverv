// Bygger ejerens side til Shopify admin. Siden serveres som ren HTML fra en
// server-rute, fordi App Bridge skal være det første script i <head> — det
// kan appens React-sider ikke love.
import pageHtml from "@/lib/admin-page.html?raw";
import clientJs from "@/lib/admin-client.js?raw";
import { shopifyEnv } from "@/lib/shopify.server";

const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function adminPageResponse(side) {
  const { clientId, store } = shopifyEnv();
  // Funktioner som erstatning, så $-tegn i koden ikke tolkes af replace.
  const html = pageHtml
    .replace("__API_KEY__", () => escapeAttr(clientId))
    .replace("__SIDE__", () => escapeAttr(side))
    .replace("__CLIENT_JS__", () => clientJs);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Kun butikkens admin må vise siden i en ramme.
      "content-security-policy": `frame-ancestors https://${store} https://admin.shopify.com;`,
    },
  });
}
