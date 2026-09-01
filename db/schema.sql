-- BloxStar — Neon PostgreSQL schema
-- Apply once against your Neon database:
--   psql "$DATABASE_URL" -f db/schema.sql

CREATE TABLE IF NOT EXISTS auth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_codes_email_idx ON auth_codes (email);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token text PRIMARY KEY,
  email text NOT NULL,
  admin boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_email_idx ON auth_sessions (email);

CREATE TABLE IF NOT EXISTS orders (
  code text PRIMARY KEY,
  intent_id text UNIQUE,
  status text NOT NULL DEFAULT 'pending_payment',
  paid boolean NOT NULL DEFAULT false,
  email text,
  roblox_user text,
  game text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  fee numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders (email);

CREATE TABLE IF NOT EXISTS item_stock (
  item_id integer PRIMARY KEY,
  qty integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reserve_stock(p_items jsonb, p_default integer DEFAULT 12)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  line jsonb;
  iid integer;
  need integer;
  have integer;
BEGIN
  FOR line IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    iid := (line->>'id')::integer;
    need := GREATEST(1, COALESCE((line->>'q')::integer, 1));
    INSERT INTO item_stock(item_id, qty)
      VALUES (iid, p_default)
      ON CONFLICT (item_id) DO NOTHING;
    SELECT qty INTO have FROM item_stock WHERE item_id = iid FOR UPDATE;
    IF have IS NULL OR have < need THEN
      RAISE EXCEPTION 'out_of_stock:%', iid;
    END IF;
    UPDATE item_stock SET qty = qty - need, updated_at = now() WHERE item_id = iid;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION release_stock(p_items jsonb)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  line jsonb;
BEGIN
  FOR line IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    UPDATE item_stock
       SET qty = qty + GREATEST(1, COALESCE((line->>'q')::integer, 1)), updated_at = now()
     WHERE item_id = (line->>'id')::integer;
  END LOOP;
  RETURN true;
END;
$$;
