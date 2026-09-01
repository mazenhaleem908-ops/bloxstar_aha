import { createFileRoute } from "@tanstack/react-router";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const Route = createFileRoute("/api/public/email/send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ ok: false, error: "invalid_payload" }, 400);
        }

        const toRaw = body["to"] ?? body["email"];
        const to = (Array.isArray(toRaw) ? toRaw : [toRaw])
          .map((v) =>
            String(v ?? "")
              .trim()
              .toLowerCase(),
          )
          .filter((v) => EMAIL_RE.test(v));
        if (to.length === 0) return json({ ok: false, error: "invalid_email" }, 400);

        const apiKey = process.env["RESEND_API_KEY"];
        if (!apiKey) {
          console.error("[email/send] RESEND_API_KEY is not configured");
          return json({ ok: false, error: "email_send_failed" }, 500);
        }

        const defaultFrom = process.env["RESEND_FROM_EMAIL"] || "business@bloxistar.com";
        const from = String(body["from"] ?? defaultFrom);
        const fromName = String(body["fromName"] ?? process.env["RESEND_FROM_NAME"] ?? "BloxStar");
        const replyTo = String(body["replyTo"] ?? from);
        const subject = String(body["subject"] ?? "BloxStar");
        const html = body["html"] ? String(body["html"]) : undefined;
        const text = body["text"] ? String(body["text"]) : undefined;
        if (!html && !text) return json({ ok: false, error: "invalid_payload" }, 400);

        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: `${fromName} <${from}>`,
            to,
            reply_to: replyTo,
            subject,
            ...(html ? { html } : {}),
            ...(text ? { text } : {}),
          }),
        });

        if (!res.ok) {
          const detail = await res.text();
          console.error("[email/send] resend failed", res.status, detail);
          return json({ ok: false, error: "email_send_failed" }, 502);
        }

        return json({ ok: true });
      },
    },
  },
});
