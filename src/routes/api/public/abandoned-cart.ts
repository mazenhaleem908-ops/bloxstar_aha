import { createFileRoute } from "@tanstack/react-router";

/**
 * Abandoned-cart reminder email (Resend).
 *
 * The storefront posts { email, name, items, total, subject, html, text }
 * after 20 minutes of inactivity. We only relay it to Resend; nothing here
 * trusts client pricing because no order is created.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const Route = createFileRoute("/api/public/abandoned-cart")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ ok: false, error: "invalid_payload" }, 400);
        }

        const to = String(body["email"] ?? body["to"] ?? "")
          .trim()
          .toLowerCase();
        if (!EMAIL_RE.test(to)) return json({ ok: false, error: "invalid_email" }, 400);

        const html = body["html"] ? String(body["html"]) : undefined;
        const text = body["text"] ? String(body["text"]) : undefined;
        if (!html && !text) return json({ ok: false, error: "invalid_payload" }, 400);

        const apiKey = process.env["RESEND_API_KEY"];
        if (!apiKey) {
          console.error("[abandoned-cart] RESEND_API_KEY is not configured");
          return json({ ok: false, error: "email_send_failed" }, 500);
        }

        const from = process.env["RESEND_FROM_EMAIL"] || "business@bloxistar.com";
        const fromName = process.env["RESEND_FROM_NAME"] || "BloxStar";
        const subject = String(body["subject"] ?? "You left something in your cart — BloxStar");

        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: `${fromName} <${from}>`,
            to: [to],
            reply_to: from,
            subject,
            ...(html ? { html } : {}),
            ...(text ? { text } : {}),
          }),
        });

        if (!res.ok) {
          const detail = await res.text();
          console.error("[abandoned-cart] resend failed", res.status, detail);
          return json({ ok: false, error: "email_send_failed" }, 502);
        }

        return json({ ok: true });
      },
    },
  },
});
