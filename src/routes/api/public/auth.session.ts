import { createFileRoute } from "@tanstack/react-router";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const Route = createFileRoute("/api/public/auth/session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ ok: false });
        }

        const token = String(body["token"] ?? "").trim();
        if (!token) return json({ ok: false });

        const { db } = await import("@/lib/db");
        const sql = db();
        const rows = (await sql`
          SELECT email, admin, expires_at FROM auth_sessions WHERE token = ${token} LIMIT 1
        `) as Array<{ email: string; admin: boolean; expires_at: string }>;

        const row = rows[0];
        if (!row) return json({ ok: false });
        if (new Date(row.expires_at).getTime() < Date.now()) {
          await sql`DELETE FROM auth_sessions WHERE token = ${token}`;
          return json({ ok: false });
        }

        return json({ ok: true, email: row.email, admin: row.admin });
      },
    },
  },
});
