import { createFileRoute } from "@tanstack/react-router";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ADMIN_EMAILS = (
  process.env["ADMIN_EMAILS"] ||
  "mazenhaleem908@gmail.com,kareemahmedhalim@gmail.com,sagedhalim9@gmail.com"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const Route = createFileRoute("/api/public/auth/verify-code")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ ok: false, error: "invalid" }, 400);
        }

        const email = String(body["email"] ?? "")
          .trim()
          .toLowerCase();
        const code = String(body["code"] ?? "").trim();
        if (!email || !/^\d{4,8}$/.test(code)) return json({ ok: false, error: "invalid" }, 400);

        const { db } = await import("@/lib/db");
        const sql = db();

        const rows = (await sql`
          SELECT id, code, expires_at, attempts FROM auth_codes
          WHERE email = ${email}
          ORDER BY created_at DESC
          LIMIT 1
        `) as Array<{ id: string; code: string; expires_at: string; attempts: number }>;

        const row = rows[0];
        if (!row) return json({ ok: false, error: "expired" }, 400);
        if (new Date(row.expires_at).getTime() < Date.now()) {
          await sql`DELETE FROM auth_codes WHERE id = ${row.id}`;
          return json({ ok: false, error: "expired" }, 400);
        }
        if (row.attempts >= 5) {
          await sql`DELETE FROM auth_codes WHERE id = ${row.id}`;
          return json({ ok: false, error: "expired" }, 429);
        }
        if (row.code !== code) {
          await sql`UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ${row.id}`;
          return json({ ok: false, error: "invalid" }, 400);
        }

        await sql`DELETE FROM auth_codes WHERE id = ${row.id}`;

        const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        const admin = ADMIN_EMAILS.includes(email);
        try {
          await sql`
            INSERT INTO auth_sessions (token, email, admin, expires_at)
            VALUES (${token}, ${email}, ${admin}, now() + interval '30 days')
          `;
        } catch (error) {
          console.error("[auth/verify-code] session insert failed", error);
          return json({ ok: false, error: "invalid" }, 500);
        }

        return json({ ok: true, token, email, admin });
      },
    },
  },
});
