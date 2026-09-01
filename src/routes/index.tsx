import { createFileRoute } from "@tanstack/react-router";

// The BloxStar storefront is a complete self-contained HTML application
// (public/storefront.html). It is served verbatim at "/" so every page
// container, script, style and product stays exactly as authored.
export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const res = await fetch(new URL("/storefront.html", request.url));
        const html = await res.text();
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  },
});
