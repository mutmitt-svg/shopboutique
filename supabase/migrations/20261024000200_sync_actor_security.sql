-- v3: bind every cloud sync operation to the local staff identity as well as the tenant.
DROP FUNCTION IF EXISTS public.apply_sync_operation(uuid,text,text,text,text,jsonb,bigint);
CREATE OR REPLACE FUNCTION public.apply_sync_operation(
  p_operation_id uuid,
  p_store_id text,
  p_entity text,
  p_operation text,
  p_record_id text,
  p_payload jsonb,
  p_actor_id text,
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
  local_role text;
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
    WHEN 'users' THEN 'app_users'
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
  IF p_actor_id IS NULL OR length(trim(p_actor_id)) = 0 THEN RAISE EXCEPTION 'Local actor is required' USING ERRCODE = '42501'; END IF;
  SELECT u.role INTO local_role FROM public.app_users u
   WHERE u.id = p_actor_id AND u.store_id = p_store_id AND u.active = true;
  IF local_role IS NULL AND p_entity = 'users' AND p_operation = 'insert' AND p_actor_id = p_record_id THEN
    local_role := p_payload ->> 'role';
  END IF;
  IF local_role IS NULL THEN RAISE EXCEPTION 'Local staff identity is not provisioned in this tenant' USING ERRCODE = '42501'; END IF;
  IF p_entity = 'users' AND (actor_role NOT IN ('owner','manager') OR local_role NOT IN ('owner','manager')) THEN
    RAISE EXCEPTION 'Only an owner/manager can synchronize staff profiles' USING ERRCODE = '42501';
  END IF;
  IF p_entity = 'users' AND p_payload ->> 'role' = 'owner' AND actor_role <> 'owner' THEN
    RAISE EXCEPTION 'Only a cloud owner can assign owner role' USING ERRCODE = '42501';
  END IF;
  IF p_entity = 'users' AND p_payload ->> 'role' = 'manager' AND actor_role <> 'owner' THEN
    RAISE EXCEPTION 'Only a cloud owner can assign manager role' USING ERRCODE = '42501';
  END IF;
  IF local_role = 'accountant' AND p_entity <> 'audit_log' THEN
    RAISE EXCEPTION 'Accountant role is read-only for synchronization' USING ERRCODE = '42501';
  END IF;
  IF local_role = 'seller' AND p_entity NOT IN ('sales','sale_lines','sale_payments','stock_movements','cash_movements','customers','audit_log','imei_units','inventory_sessions','trade_ins') THEN
    RAISE EXCEPTION 'Seller role cannot synchronize this entity' USING ERRCODE = '42501';
  END IF;
  IF local_role = 'seller' AND p_operation = 'update' AND (p_entity <> 'imei_units' OR (p_payload - 'id' - 'lifecycle_status' - 'sold_at') <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'Seller update payload is not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_operation IN ('update','cancel') AND (actor_role NOT IN ('owner','manager') OR local_role NOT IN ('owner','manager')) AND NOT (local_role = 'seller' AND p_entity = 'imei_units' AND p_operation = 'update') THEN
    RAISE EXCEPTION 'Role cannot modify this record' USING ERRCODE = '42501';
  END IF;
  IF p_entity IN ('stock_movements','journal_entries','audit_log') AND p_operation <> 'insert' THEN
    RAISE EXCEPTION 'Ledger records are append-only';
  END IF;

  payload := (p_payload - 'tenant_id' - 'pin' - 'pin_hash' - 'pin_salt') || jsonb_build_object('id', p_record_id, 'store_id', p_store_id);
  payload_hash := md5(payload::text || ':' || p_operation || ':' || p_entity);
  SELECT s.payload_hash INTO existing_hash FROM public.sync_applied_operations s WHERE s.operation_id = p_operation_id;
  IF existing_hash IS NOT NULL THEN
    IF existing_hash <> payload_hash THEN RAISE EXCEPTION 'Idempotency key reused with different payload'; END IF;
    RETURN jsonb_build_object('status','already_applied','operation_id',p_operation_id);
  END IF;

  -- Older local installs may already have a cloud staff profile. Do not overwrite it
  -- from an INSERT replay; acknowledge only if the profile belongs to this tenant.
  IF p_entity = 'users' AND p_operation = 'insert' AND EXISTS (
    SELECT 1 FROM public.app_users u WHERE u.id = p_record_id AND u.store_id = p_store_id
  ) THEN
    INSERT INTO public.sync_applied_operations(operation_id, store_id, record_id, entity_type, payload_hash)
    VALUES (p_operation_id, p_store_id, p_record_id, p_entity, payload_hash);
    RETURN jsonb_build_object('status','already_provisioned','operation_id',p_operation_id);
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
REVOKE ALL ON FUNCTION public.apply_sync_operation(uuid,text,text,text,text,jsonb,text,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_sync_operation(uuid,text,text,text,text,jsonb,text,bigint) TO authenticated;
