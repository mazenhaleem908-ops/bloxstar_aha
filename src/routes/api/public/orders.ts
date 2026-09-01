import { createFileRoute } from "@tanstack/react-router";
import { catalogItem } from "@/lib/catalog";

/**
 * Secure order service for the BloxStar storefront (Neon PostgreSQL).
 *
 * Everything that decides money or fulfilment happens here, never in the browser:
 *   - prices come from the server catalogue (client prices are ignored)
 *   - the card fee is recomputed server-side (4.5%, $3.99 minimum)
 *   - stock is reserved atomically in the database and released on cancel
 *   - a MoonPay intent can create at most one live order (unique intent_id)
 *   - `paid` / `delivered` / `cancelled` can only be set by an admin session
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const MAX_QTY = 25;
const MAX_TOTAL = 5000;
const DEFAULT_STOCK = 12;
const CARD_FEE_PCT = 0.045;
const CARD_FEE_MIN = 3.99;

const round2 = (n: number) => Math.round(n * 100) / 100;
const cardFee = (subtotal: number) =>
  subtotal <= 0 ? 0 : round2(Math.max(subtotal * CARD_FEE_PCT, CARD_FEE_MIN));

type Line = { id: number; n: string; q: number; p: number };

function priceItems(raw: unknown): { items: Line[]; subtotal: number } {
  const items: Line[] = [];
  let subtotal = 0;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const line = (entry ?? {}) as Record<string, unknown>;
      const item = catalogItem(line["id"]);
      if (!item) continue;
      const q = Math.max(1, Math.min(MAX_QTY, parseInt(String(line["q"] ?? 1), 10) || 1));
      const existing = items.find((l) => l.id === item.id);
      if (existing) {
        existing.q = Math.min(MAX_QTY, existing.q + q);
      } else {
        items.push({ id: item.id, n: item.n, q, p: item.p });
      }
    }
    for (const l of items) subtotal += l.p * l.q;
  }
  return { items, subtotal: round2(subtotal) };
}

const database = async () => (await import("@/lib/db")).db();
type Sql = Awaited<ReturnType<typeof database>>;

type Session = { email: string; admin: boolean } | null;

async function sessionFor(request: Request, bodyToken: unknown): Promise<Session> {
  const header = request.headers.get("authorization") || "";
  const token = (header.replace(/^Bearer\s+/i, "").trim() || String(bodyToken ?? "").trim()).slice(
    0,
    200,
  );
  if (!token) return null;
  const sql = await database();
  const rows = (await sql`
    SELECT email, admin, expires_at FROM auth_sessions WHERE token = ${token} LIMIT 1
  `) as Array<{ email: string; admin: boolean; expires_at: string }>;
  const data = rows[0];
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return { email: data.email, admin: !!data.admin };
}

type OrderRow = {
  code: string;
  intent_id: string | null;
  status: string;
  paid: boolean;
  email: string | null;
  roblox_user: string | null;
  game: string | null;
  items: unknown;
  subtotal: number;
  fee: number;
  total: number;
  created_at: string;
};

const apiOrder = (o: OrderRow) => ({
  code: o.code,
  status: o.status,
  paid: o.paid,
  email: o.email || "",
  robloxUser: o.roblox_user || "",
  game: o.game || "mm2",
  items: (Array.isArray(o.items) ? (o.items as Line[]) : []).map((i) => ({
    id: i.id,
    name: i.n,
    q: i.q,
    price: i.p,
  })),
  subtotal: Number(o.subtotal),
  fee: Number(o.fee),
  total: Number(o.total),
  createdAt: o.created_at,
});

async function newCode(sql: Sql): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    const code = String(100000 + ((bytes[0] ?? 0) % 900000));
    const rows = (await sql`SELECT code FROM orders WHERE code = ${code} LIMIT 1`) as Array<{
      code: string;
    }>;
    if (!rows[0]) return code;
  }
  throw new Error("code_exhausted");
}

async function reserveStock(sql: Sql, items: Array<{ id: number; q: number }>) {
  await sql`SELECT reserve_stock(${JSON.stringify(items)}::jsonb, ${DEFAULT_STOCK})`;
}

async function releaseStock(sql: Sql, items: Array<{ id: number; q: number }>) {
  if (!items.length) return;
  try {
    await sql`SELECT release_stock(${JSON.stringify(items)}::jsonb)`;
  } catch (error) {
    console.error("[orders] release_stock failed", error);
  }
}

async function orderByIntent(sql: Sql, intentId: string): Promise<OrderRow | undefined> {
  const rows = (await sql`
    SELECT code, intent_id, status, paid, email, roblox_user, game, items,
           subtotal, fee, total, created_at
    FROM orders WHERE intent_id = ${intentId} LIMIT 1
  `) as OrderRow[];
  return rows[0];
}

async function createOrder(request: Request, body: Record<string, unknown>) {
  const intentId = String(body["intentId"] ?? body["intent_id"] ?? "").trim();
  if (!intentId || intentId.length > 80) return json({ ok: false, error: "invalid_intent" }, 400);

  const priced = priceItems(body["items"]);
  if (!priced.items.length) return json({ ok: false, error: "empty_cart" }, 400);

  const fee = cardFee(priced.subtotal);
  const total = round2(priced.subtotal + fee);
  if (!isFinite(total) || total <= 0 || total > MAX_TOTAL)
    return json({ ok: false, error: "invalid_total" }, 400);

  const sql = await database();

  // one intent -> exactly one order (replay proof)
  const existing = await orderByIntent(sql, intentId);
  if (existing) {
    return json({ ok: true, code: existing.code, status: existing.status, order: apiOrder(existing) });
  }

  const session = await sessionFor(request, body["token"]);
  const email = String(body["email"] ?? session?.email ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 200);
  const robloxUser = String(body["user"] ?? "")
    .trim()
    .slice(0, 60);
  const game = String(body["game"] ?? "mm2")
    .trim()
    .slice(0, 30);

  // stock is reserved in the database, so two checkouts cannot take the same item
  const stockItems = priced.items.map((i) => ({ id: i.id, q: i.q }));
  try {
    await reserveStock(sql, stockItems);
  } catch (stockError) {
    const message = stockError instanceof Error ? stockError.message : String(stockError);
    const outOf = /out_of_stock:(\d+)/.exec(message);
    if (!outOf) console.error("[orders] reserve_stock failed", stockError);
    return json({ ok: false, error: "out_of_stock", itemId: outOf ? Number(outOf[1]) : null }, 409);
  }

  let code: string;
  try {
    code = await newCode(sql);
  } catch {
    await releaseStock(sql, stockItems);
    return json({ ok: false, error: "code_failed" }, 500);
  }

  const data = { code, pay: "Visa / Card (MoonPay)", intentId, stockDeducted: true };

  try {
    const created = (await sql`
      INSERT INTO orders (code, intent_id, status, paid, email, roblox_user, game,
                          items, subtotal, fee, total, data)
      VALUES (${code}, ${intentId}, 'pending_payment', false, ${email}, ${robloxUser}, ${game},
              ${JSON.stringify(priced.items)}::jsonb, ${priced.subtotal}, ${fee}, ${total},
              ${JSON.stringify(data)}::jsonb)
      RETURNING code, intent_id, status, paid, email, roblox_user, game, items,
                subtotal, fee, total, created_at
    `) as OrderRow[];
    const row = created[0];
    if (!row) throw new Error("insert_returned_nothing");
    return json({ ok: true, code: row.code, status: row.status, order: apiOrder(row) }, 201);
  } catch (error) {
    // a racing request may have won the unique intent_id — return that order
    const raced = await orderByIntent(sql, intentId);
    if (raced) {
      return json({ ok: true, code: raced.code, status: raced.status, order: apiOrder(raced) });
    }
    await releaseStock(sql, stockItems);
    console.error("[orders] insert failed", error);
    return json({ ok: false, error: "create_failed" }, 500);
  }
}

async function transition(request: Request, body: Record<string, unknown>, action: string) {
  const code = String(body["code"] ?? "").trim();
  if (!/^\d{6}$/.test(code)) return json({ ok: false, error: "invalid" }, 400);

  const session = await sessionFor(request, body["token"]);
  if (!session?.admin) return json({ ok: false, error: "forbidden" }, 403);

  const sql = await database();
  const rows = (await sql`
    SELECT code, intent_id, status, paid, email, roblox_user, game, items,
           subtotal, fee, total, created_at
    FROM orders WHERE code = ${code} LIMIT 1
  `) as OrderRow[];
  const row = rows[0];
  if (!row) return json({ ok: false, error: "not_found" }, 404);

  if (row.status === "delivered" || row.status === "cancelled")
    return json({ ok: false, error: "already_processed", status: row.status }, 409);

  const next = action === "confirm" ? "delivered" : "cancelled";
  try {
    await sql`
      UPDATE orders
         SET status = ${next}, paid = ${next === "delivered"}, updated_at = now()
       WHERE code = ${code}
         AND status IN ('pending_payment', 'pending', 'processing', 'paid')
    `;
  } catch (error) {
    console.error("[orders] transition failed", error);
    return json({ ok: false, error: "update_failed" }, 500);
  }

  if (next === "cancelled") {
    const items = Array.isArray(row.items) ? (row.items as Line[]) : [];
    await releaseStock(
      sql,
      items.map((i) => ({ id: i.id, q: i.q })),
    );
  }

  return json({ ok: true, code, status: next });
}

async function listOrders(request: Request, body: Record<string, unknown>) {
  const session = await sessionFor(request, body["token"]);
  if (!session?.admin) return json({ ok: false, error: "forbidden" }, 403);
  const sql = await database();
  const rows = (await sql`
    SELECT code, intent_id, status, paid, email, roblox_user, game, items,
           subtotal, fee, total, created_at
    FROM orders ORDER BY created_at DESC LIMIT 500
  `) as OrderRow[];
  return json({
    ok: true,
    orders: rows.map((o) => ({
      code: o.code,
      status: o.status,
      created_at: o.created_at,
      data: { ...apiOrder(o), pay: "Visa / Card (MoonPay)", date: o.created_at },
    })),
  });
}

async function mineOrders(body: Record<string, unknown>) {
  const raw = Array.isArray(body["codes"]) ? (body["codes"] as unknown[]) : [];
  const codes = raw
    .map((c) => String(c).trim())
    .filter((c) => /^\d{6}$/.test(c))
    .slice(0, 50);
  if (!codes.length) return json({ ok: true, orders: [] });
  const sql = await database();
  const rows = (await sql`
    SELECT code, intent_id, status, paid, email, roblox_user, game, items,
           subtotal, fee, total, created_at
    FROM orders WHERE code = ANY(${codes})
  `) as OrderRow[];
  return json({
    ok: true,
    orders: rows.map((o) => ({
      code: o.code,
      status: o.status,
      total: Number(o.total),
      items: (Array.isArray(o.items) ? (o.items as Line[]) : []).map((i) => ({
        id: i.id,
        n: i.n,
        q: i.q,
        p: i.p,
      })),
      date: o.created_at,
    })),
  });
}

export const Route = createFileRoute("/api/public/orders")({
  server: {
    handlers: {
      // Read: admin sees everything, a signed-in customer sees only their own orders.
      GET: async ({ request }) => {
        const session = await sessionFor(request, null);
        if (!session) return json({ orders: [] });
        const url = new URL(request.url);
        const sql = await database();
        const all = session.admin && url.searchParams.get("all") === "1";
        const rows = (
          all
            ? await sql`
                SELECT code, intent_id, status, paid, email, roblox_user, game, items,
                       subtotal, fee, total, created_at
                FROM orders ORDER BY created_at DESC LIMIT 500
              `
            : await sql`
                SELECT code, intent_id, status, paid, email, roblox_user, game, items,
                       subtotal, fee, total, created_at
                FROM orders WHERE email = ${session.email}
                ORDER BY created_at DESC LIMIT 500
              `
        ) as OrderRow[];
        return json({ orders: rows.map(apiOrder) });
      },

      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = ((await request.json()) ?? {}) as Record<string, unknown>;
        } catch {
          return json({ ok: false, error: "invalid" }, 400);
        }
        const action = String(body["action"] ?? "create").toLowerCase();
        if (action === "list") return listOrders(request, body);
        if (action === "mine") return mineOrders(body);
        if (action === "confirm" || action === "cancel") return transition(request, body, action);
        if (action === "create") return createOrder(request, body);
        return json({ ok: false, error: "unknown_action" }, 400);
      },

      // Status changes are admin-only, whatever shape the caller uses.
      PATCH: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = ((await request.json()) ?? {}) as Record<string, unknown>;
        } catch {
          return json({ ok: false, error: "invalid" }, 400);
        }
        const action = String(body["action"] ?? "").toLowerCase();
        if (action !== "confirm" && action !== "cancel")
          return json({ ok: false, error: "unknown_action" }, 400);
        return transition(request, body, action);
      },
    },
  },
});
