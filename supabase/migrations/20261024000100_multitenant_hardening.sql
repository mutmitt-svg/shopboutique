-- TeleBoutik POS v2: tenant isolation and least-privilege RLS.
-- Review/backfill legacy rows before deploying to production.

CREATE TABLE IF NOT EXISTS store_memberships (
  store_id text NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  app_role text NOT NULL CHECK (app_role IN ('owner','manager','seller','accountant')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, user_id)
);
ALTER TABLE store_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_memberships FORCE ROW LEVEL SECURITY;
REVOKE ALL ON store_memberships FROM anon, public;
GRANT SELECT ON store_memberships TO authenticated;
DROP POLICY IF EXISTS memberships_read_self ON store_memberships;
CREATE POLICY memberships_read_self ON store_memberships
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- The old schema permits null store_id on some child tables. Do not silently
-- guess tenant ownership if more than one store exists.
DO $$
DECLARE store_count integer;
DECLARE only_store text;
DECLARE t text;
BEGIN
  SELECT count(*), min(id) INTO store_count, only_store FROM stores;
  IF store_count > 1 THEN
    RAISE EXCEPTION 'Multi-tenant migration requires explicit mapping of legacy rows before deployment';
  END IF;
  FOREACH t IN ARRAY ARRAY[
    'app_users','products','product_variants','imei_units','stock_movements',
    'customers','suppliers','sales','sale_lines','sale_payments','cash_sessions',
    'cash_movements','expenses','journal_entries','credit_plans','credit_installments',
    'purchases','purchase_lines','audit_log','settings','sync_ops'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS store_id text', t);
    IF store_count = 1 THEN
      EXECUTE format('UPDATE %I SET store_id = $1 WHERE store_id IS NULL', t) USING only_store;
    END IF;
  END LOOP;
END $$;

-- Membership helper: callers cannot choose an arbitrary tenant without a
-- server-managed membership row. Keep function output narrow and search_path fixed.
CREATE OR REPLACE FUNCTION public.is_store_member(p_store_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.store_memberships m
    WHERE m.store_id = p_store_id
      AND m.user_id = (SELECT auth.uid())
      AND m.active = true
  );
$$;
REVOKE ALL ON FUNCTION public.is_store_member(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_store_member(text) TO authenticated;

-- Remove all previous policies (permissive policies combine with OR) and
-- recreate tenant-scoped policies. The store itself is scoped by its id.
DO $$
DECLARE t text;
DECLARE p record;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stores','app_users','products','product_variants','imei_units','stock_movements',
    'customers','suppliers','sales','sale_lines','sale_payments','cash_sessions',
    'cash_movements','expenses','journal_entries','credit_plans','credit_installments',
    'purchases','purchase_lines','audit_log','settings','sync_ops'
  ] LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, public', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO authenticated', t);
    IF t IN ('stock_movements','journal_entries','audit_log') THEN
      EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM authenticated', t);
    ELSE
      EXECUTE format('GRANT DELETE ON public.%I TO authenticated', t);
    END IF;

    IF t = 'stores' THEN
      EXECUTE 'CREATE POLICY tenant_select ON public.stores FOR SELECT TO authenticated USING (public.is_store_member(id))';
      EXECUTE 'CREATE POLICY tenant_insert ON public.stores FOR INSERT TO authenticated WITH CHECK (id IS NOT NULL AND public.is_store_member(id))';
      EXECUTE 'CREATE POLICY tenant_update ON public.stores FOR UPDATE TO authenticated USING (public.is_store_member(id)) WITH CHECK (public.is_store_member(id))';
    ELSE
      EXECUTE format('CREATE POLICY tenant_select ON public.%I FOR SELECT TO authenticated USING (public.is_store_member(store_id))', t);
      EXECUTE format('CREATE POLICY tenant_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.is_store_member(store_id))', t);
      EXECUTE format('CREATE POLICY tenant_update ON public.%I FOR UPDATE TO authenticated USING (public.is_store_member(store_id)) WITH CHECK (public.is_store_member(store_id))', t);
      IF t NOT IN ('stock_movements','journal_entries','audit_log') THEN
        EXECUTE format('CREATE POLICY tenant_delete ON public.%I FOR DELETE TO authenticated USING (public.is_store_member(store_id))', t);
      END IF;
    END IF;
  END LOOP;
END $$;

-- Never store employee PINs in the cloud in plaintext. The application should
-- use Supabase Auth and/or a server-side PIN verifier, not sync local PIN fields.
REVOKE ALL ON public.app_users FROM anon, public;

CREATE INDEX IF NOT EXISTS idx_memberships_user_active ON store_memberships(user_id, active);
CREATE INDEX IF NOT EXISTS idx_sales_store_date ON sales(store_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_sync_ops_store ON sync_ops(store_id);

-- Tenant provisioning must be a single server-side transaction. Users cannot
-- create a store and then self-assign membership through direct table writes.
CREATE OR REPLACE FUNCTION public.create_store_for_current_user(
  p_name text,
  p_address text DEFAULT '',
  p_phone text DEFAULT '',
  p_currency text DEFAULT 'XOF'
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE new_store_id text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF length(trim(coalesce(p_name, ''))) < 2 THEN
    RAISE EXCEPTION 'Store name is required';
  END IF;
  new_store_id := gen_random_uuid()::text;
  INSERT INTO public.stores(id, name, address, phone, currency)
  VALUES (new_store_id, trim(p_name), coalesce(p_address, ''), coalesce(p_phone, ''), coalesce(p_currency, 'XOF'));
  INSERT INTO public.store_memberships(store_id, user_id, app_role, active)
  VALUES (new_store_id, auth.uid(), 'owner', true);
  RETURN new_store_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_store_for_current_user(text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_store_for_current_user(text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.has_store_role(p_store_id text, p_roles text[])
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.store_memberships m
    WHERE m.store_id = p_store_id
      AND m.user_id = (SELECT auth.uid())
      AND m.active = true
      AND m.app_role = ANY(p_roles)
  );
$$;
REVOKE ALL ON FUNCTION public.has_store_role(text,text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_store_role(text,text[]) TO authenticated;

-- Tenant membership controls visibility; role controls mutation. A user must
-- never be able to grant themselves a role by editing client-side state.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'app_users','products','product_variants','imei_units','stock_movements',
    'customers','suppliers','sales','sale_lines','sale_payments','cash_sessions',
    'cash_movements','expenses','journal_entries','credit_plans','credit_installments',
    'purchases','purchase_lines','audit_log','settings','sync_ops'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_insert ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_update ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_delete ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.has_store_role(store_id, ARRAY[''owner'',''manager'',''seller'']))', t
    );
    IF t NOT IN ('stock_movements','journal_entries','audit_log') THEN
      EXECUTE format(
        'CREATE POLICY tenant_update ON public.%I FOR UPDATE TO authenticated USING (public.has_store_role(store_id, ARRAY[''owner'',''manager''])) WITH CHECK (public.has_store_role(store_id, ARRAY[''owner'',''manager'']))', t
      );
      EXECUTE format(
        'CREATE POLICY tenant_delete ON public.%I FOR DELETE TO authenticated USING (public.has_store_role(store_id, ARRAY[''owner'']))', t
      );
    END IF;
  END LOOP;
  DROP POLICY IF EXISTS tenant_insert ON public.stores;
  DROP POLICY IF EXISTS tenant_update ON public.stores;
  CREATE POLICY tenant_update ON public.stores FOR UPDATE TO authenticated
    USING (public.has_store_role(id, ARRAY['owner']))
    WITH CHECK (public.has_store_role(id, ARRAY['owner']));
END $$;

-- Tenant-local uniqueness: the same SKU or setting key may exist in different
-- stores, but not twice inside one store.
ALTER TABLE public.product_variants DROP CONSTRAINT IF EXISTS product_variants_sku_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_variants_store_sku
  ON public.product_variants(store_id, sku);
ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_settings_store_key
  ON public.settings(store_id, key);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'app_users','products','product_variants','imei_units','stock_movements',
    'customers','suppliers','sales','sale_lines','sale_payments','cash_sessions',
    'cash_movements','expenses','journal_entries','credit_plans','credit_installments',
    'purchases','purchase_lines','audit_log','settings','sync_ops'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN store_id SET NOT NULL', t);
  END LOOP;
END $$;

-- Tighten sensitive tables beyond the general operational role set.
DROP POLICY IF EXISTS tenant_insert ON public.app_users;
CREATE POLICY tenant_insert ON public.app_users FOR INSERT TO authenticated
  WITH CHECK (public.has_store_role(store_id, ARRAY['owner','manager']));
DROP POLICY IF EXISTS tenant_update ON public.app_users;
CREATE POLICY tenant_update ON public.app_users FOR UPDATE TO authenticated
  USING (public.has_store_role(store_id, ARRAY['owner','manager']))
  WITH CHECK (public.has_store_role(store_id, ARRAY['owner','manager']));
DROP POLICY IF EXISTS tenant_delete ON public.app_users;
CREATE POLICY tenant_delete ON public.app_users FOR DELETE TO authenticated
  USING (public.has_store_role(store_id, ARRAY['owner']));

DROP POLICY IF EXISTS tenant_insert ON public.expenses;
CREATE POLICY tenant_insert ON public.expenses FOR INSERT TO authenticated
  WITH CHECK (public.has_store_role(store_id, ARRAY['owner','manager']));
DROP POLICY IF EXISTS tenant_update ON public.expenses;
CREATE POLICY tenant_update ON public.expenses FOR UPDATE TO authenticated
  USING (public.has_store_role(store_id, ARRAY['owner','manager']))
  WITH CHECK (public.has_store_role(store_id, ARRAY['owner','manager']));
DROP POLICY IF EXISTS tenant_delete ON public.expenses;
CREATE POLICY tenant_delete ON public.expenses FOR DELETE TO authenticated
  USING (public.has_store_role(store_id, ARRAY['owner']));

DROP POLICY IF EXISTS tenant_insert ON public.journal_entries;
CREATE POLICY tenant_insert ON public.journal_entries FOR INSERT TO authenticated
  WITH CHECK (public.has_store_role(store_id, ARRAY['owner','manager','accountant']));
DROP POLICY IF EXISTS tenant_insert ON public.audit_log;
CREATE POLICY tenant_insert ON public.audit_log FOR INSERT TO authenticated
  WITH CHECK (public.is_store_member(store_id));

-- Local PINs are never a cloud credential and must not be replicated.
ALTER TABLE public.app_users DROP COLUMN IF EXISTS pin;

-- Idempotency ledger for offline operations. A client cannot write to this table directly.
CREATE TABLE IF NOT EXISTS public.sync_applied_operations (
  operation_id uuid PRIMARY KEY,
  store_id text NOT NULL REFERENCES public.stores(id),
  record_id text NOT NULL,
  entity_type text NOT NULL,
  payload_hash text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sync_applied_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_applied_operations NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_applied_operations FROM PUBLIC, anon, authenticated;

-- The only client entry point for offline synchronization. Entity names are allow-listed,
-- tenant membership and role are checked on the server, and the operation id is idempotent.
CREATE OR REPLACE FUNCTION public.apply_sync_operation(
  p_operation_id uuid,
  p_store_id text,
  p_entity text,
  p_operation text,
  p_record_id text,
  p_payload jsonb,
  p_base_version bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_table text;
  payload jsonb;
  cols text;
  vals text;
  updates text;
  existing_hash text;
  payload_hash text;
  actor_role text;
  applied_count integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT m.app_role INTO actor_role
    FROM public.store_memberships m
   WHERE m.store_id = p_store_id AND m.user_id = auth.uid() AND m.active = true;
  IF actor_role IS NULL THEN RAISE EXCEPTION 'Tenant access denied' USING ERRCODE = '42501'; END IF;
  IF p_operation_id IS NULL OR p_record_id IS NULL OR p_payload IS NULL THEN
    RAISE EXCEPTION 'Invalid sync operation';
  END IF;
  IF p_operation NOT IN ('insert','update','cancel') THEN RAISE EXCEPTION 'Unsupported operation'; END IF;

  target_table := CASE p_entity
    WHEN 'products' THEN 'products'
    WHEN 'product_variants' THEN 'product_variants'
    WHEN 'imei_units' THEN 'imei_units'
    WHEN 'stock_movements' THEN 'stock_movements'
    WHEN 'customers' THEN 'customers'
    WHEN 'suppliers' THEN 'suppliers'
    WHEN 'sales' THEN 'sales'
    WHEN 'sale_lines' THEN 'sale_lines'
    WHEN 'sale_payments' THEN 'sale_payments'
    WHEN 'cash_sessions' THEN 'cash_sessions'
    WHEN 'cash_movements' THEN 'cash_movements'
    WHEN 'expenses' THEN 'expenses'
    WHEN 'journal_entries' THEN 'journal_entries'
    WHEN 'credit_plans' THEN 'credit_plans'
    WHEN 'credit_installments' THEN 'credit_installments'
    WHEN 'purchases' THEN 'purchases'
    WHEN 'purchase_lines' THEN 'purchase_lines'
    WHEN 'inventory_sessions' THEN 'inventory_sessions'
    WHEN 'trade_ins' THEN 'trade_ins'
    WHEN 'settings' THEN 'settings'
    WHEN 'audit_log' THEN 'audit_log'
    ELSE NULL
  END;
  IF target_table IS NULL THEN RAISE EXCEPTION 'Entity not permitted for synchronization'; END IF;
  IF actor_role = 'accountant' AND p_entity <> 'audit_log' THEN
    RAISE EXCEPTION 'Accountant role is read-only for synchronization' USING ERRCODE = '42501';
  END IF;
  IF actor_role = 'seller' AND p_entity NOT IN ('sales','sale_lines','sale_payments','stock_movements','cash_movements','customers','audit_log','imei_units','inventory_sessions','trade_ins') THEN
    RAISE EXCEPTION 'Seller role cannot synchronize this entity' USING ERRCODE = '42501';
  END IF;
  IF actor_role = 'seller' AND p_operation = 'update' AND (p_entity <> 'imei_units' OR (p_payload - 'id' - 'lifecycle_status' - 'sold_at') <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'Seller update payload is not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_operation IN ('update','cancel') AND actor_role NOT IN ('owner','manager') AND NOT (actor_role = 'seller' AND p_entity = 'imei_units' AND p_operation = 'update') THEN
    RAISE EXCEPTION 'Role cannot modify this record' USING ERRCODE = '42501';
  END IF;
  IF p_entity IN ('stock_movements','journal_entries','audit_log') AND p_operation <> 'insert' THEN
    RAISE EXCEPTION 'Ledger records are append-only';
  END IF;

  payload := (p_payload - 'tenant_id' - 'pin') || jsonb_build_object('id', p_record_id, 'store_id', p_store_id);
  payload_hash := md5(payload::text || ':' || p_operation || ':' || p_entity);
  SELECT s.payload_hash INTO existing_hash FROM public.sync_applied_operations s WHERE s.operation_id = p_operation_id;
  IF existing_hash IS NOT NULL THEN
    IF existing_hash <> payload_hash THEN RAISE EXCEPTION 'Idempotency key reused with different payload'; END IF;
    RETURN jsonb_build_object('status','already_applied','operation_id',p_operation_id);
  END IF;

  IF p_entity = 'sales' AND p_operation = 'cancel' THEN
    UPDATE public.sales SET status = 'cancelled'
      WHERE id = p_record_id AND store_id = p_store_id AND status <> 'cancelled';
    GET DIAGNOSTICS applied_count = ROW_COUNT;
    IF applied_count = 0 THEN
      IF EXISTS (SELECT 1 FROM public.sales WHERE id = p_record_id AND store_id = p_store_id AND status = 'cancelled') THEN
        NULL;
      ELSE
        RAISE EXCEPTION 'Sale not found in tenant or already inaccessible';
      END IF;
    END IF;
  ELSE
    IF p_operation = 'update' AND actor_role NOT IN ('owner','manager') THEN
      RAISE EXCEPTION 'Update requires manager permission' USING ERRCODE = '42501';
    END IF;
    SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum),
           string_agg(format('r.%I', a.attname), ', ' ORDER BY a.attnum),
           string_agg(format('%I = EXCLUDED.%I', a.attname, a.attname), ', ' ORDER BY a.attnum)
      INTO cols, vals, updates
      FROM pg_attribute a
     WHERE a.attrelid = format('public.%I', target_table)::regclass
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname IN (SELECT jsonb_object_keys(payload))
       AND a.attname <> 'id';
    IF cols IS NULL THEN RAISE EXCEPTION 'Payload has no supported columns'; END IF;
    IF p_operation = 'insert' THEN
      EXECUTE format(
        'INSERT INTO public.%I (id, %s) SELECT $2, %s FROM jsonb_populate_record(NULL::public.%I, $1) r ON CONFLICT (id) DO NOTHING',
        target_table, cols, vals, target_table
      ) USING payload, p_record_id;
    ELSE
      EXECUTE format(
        'INSERT INTO public.%I (id, %s) SELECT $2, %s FROM jsonb_populate_record(NULL::public.%I, $1) r ON CONFLICT (id) DO UPDATE SET %s WHERE public.%I.store_id = EXCLUDED.store_id',
        target_table, cols, vals, target_table, updates, target_table
      ) USING payload, p_record_id;
    END IF;
    GET DIAGNOSTICS applied_count = ROW_COUNT;
    IF applied_count = 0 THEN RAISE EXCEPTION 'Record already exists or tenant conflict'; END IF;
  END IF;

  INSERT INTO public.sync_applied_operations(operation_id, store_id, record_id, entity_type, payload_hash)
  VALUES (p_operation_id, p_store_id, p_record_id, p_entity, payload_hash);
  RETURN jsonb_build_object('status','applied','operation_id',p_operation_id);
END;
$$;
REVOKE ALL ON FUNCTION public.apply_sync_operation(uuid,text,text,text,text,jsonb,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_sync_operation(uuid,text,text,text,text,jsonb,bigint) TO authenticated;

-- Link the locally created tenant to the authenticated cloud owner. The caller may
-- claim a new ID only when that store does not yet exist; existing stores require
-- an already-established membership and cannot be taken over.
CREATE OR REPLACE FUNCTION public.register_local_store(
  p_store_id text,
  p_name text,
  p_address text DEFAULT '',
  p_phone text DEFAULT '',
  p_currency text DEFAULT 'CDF'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_store_id IS NULL OR length(trim(p_store_id)) < 8 OR length(trim(coalesce(p_name,''))) < 2 THEN
    RAISE EXCEPTION 'Invalid local store details';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stores s WHERE s.id = p_store_id) THEN
    IF NOT public.is_store_member(p_store_id) THEN
      RAISE EXCEPTION 'Store already exists and is not linked to this account' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object('status','already_linked','store_id',p_store_id);
  END IF;
  INSERT INTO public.stores(id, name, address, phone, currency)
  VALUES (p_store_id, trim(p_name), coalesce(p_address,''), coalesce(p_phone,''), coalesce(p_currency,'CDF'));
  INSERT INTO public.store_memberships(store_id, user_id, app_role, active)
  VALUES (p_store_id, auth.uid(), 'owner', true);
  RETURN jsonb_build_object('status','linked','store_id',p_store_id);
END;
$$;
REVOKE ALL ON FUNCTION public.register_local_store(text,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_local_store(text,text,text,text,text) TO authenticated;

-- The owner-only SECURITY DEFINER provisioning routine must be able to create the
-- store before a membership row exists. Client access remains constrained by RLS.
ALTER TABLE public.stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.store_memberships NO FORCE ROW LEVEL SECURITY;

-- These two modules exist locally and are part of the sync allow-list; create their
-- cloud counterparts explicitly because older installations may not have them yet.
CREATE TABLE IF NOT EXISTS public.inventory_sessions (
  id text PRIMARY KEY,
  store_id text NOT NULL REFERENCES public.stores(id),
  user_id text NOT NULL,
  category text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','validated')),
  started_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  notes text
);
ALTER TABLE public.inventory_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_sessions FROM anon, public;
GRANT SELECT, INSERT, UPDATE ON public.inventory_sessions TO authenticated;
CREATE POLICY inventory_sessions_select ON public.inventory_sessions FOR SELECT TO authenticated USING (public.is_store_member(store_id));
CREATE POLICY inventory_sessions_insert ON public.inventory_sessions FOR INSERT TO authenticated WITH CHECK (public.has_store_role(store_id, ARRAY['owner','manager','seller']));
CREATE POLICY inventory_sessions_update ON public.inventory_sessions FOR UPDATE TO authenticated USING (public.has_store_role(store_id, ARRAY['owner','manager'])) WITH CHECK (public.has_store_role(store_id, ARRAY['owner','manager']));

CREATE TABLE IF NOT EXISTS public.trade_ins (
  id text PRIMARY KEY,
  store_id text NOT NULL REFERENCES public.stores(id),
  customer_id text,
  variant_id text,
  imei1 text NOT NULL,
  imei2 text,
  brand text NOT NULL,
  model text NOT NULL,
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
  photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_cost real NOT NULL DEFAULT 0,
  grade text NOT NULL DEFAULT 'C' CHECK (grade IN ('A','B','C')),
  status text NOT NULL DEFAULT 'evaluated' CHECK (status IN ('evaluated','in_stock','sold','rejected')),
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.trade_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_ins FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_ins FROM anon, public;
GRANT SELECT, INSERT, UPDATE ON public.trade_ins TO authenticated;
CREATE POLICY trade_ins_select ON public.trade_ins FOR SELECT TO authenticated USING (public.is_store_member(store_id));
CREATE POLICY trade_ins_insert ON public.trade_ins FOR INSERT TO authenticated WITH CHECK (public.has_store_role(store_id, ARRAY['owner','manager','seller']));
CREATE POLICY trade_ins_update ON public.trade_ins FOR UPDATE TO authenticated USING (public.has_store_role(store_id, ARRAY['owner','manager'])) WITH CHECK (public.has_store_role(store_id, ARRAY['owner','manager']));
