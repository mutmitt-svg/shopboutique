import { PGlite } from '@electric-sql/pglite';

let db: PGlite | null = null;

export async function getDb(): Promise<PGlite> {
  if (db) return db;

  db = new PGlite('idb://teleboutik-db');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'XOF',
      currency_decimals INTEGER NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_enabled BOOLEAN NOT NULL DEFAULT false,
      max_seller_discount REAL NOT NULL DEFAULT 5,
      max_manager_discount REAL NOT NULL DEFAULT 10,
      credit_limit_default REAL NOT NULL DEFAULT 50000,
      return_window_days INTEGER NOT NULL DEFAULT 7,
      ticket_width TEXT NOT NULL DEFAULT '58',
      footer_text TEXT NOT NULL DEFAULT 'Merci de votre visite!'
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pin TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','manager','seller','accountant')),
      active BOOLEAN NOT NULL DEFAULT true,
      commission_rate REAL NOT NULL DEFAULT 0,
      fixed_salary REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      brand TEXT NOT NULL,
      family TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      category TEXT NOT NULL,
      image_url TEXT,
      is_serialized BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      sku TEXT NOT NULL UNIQUE,
      barcode TEXT NOT NULL DEFAULT '',
      attributes TEXT NOT NULL DEFAULT '{}',
      purchase_price REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      wholesale_price REAL NOT NULL DEFAULT 0,
      min_stock INTEGER NOT NULL DEFAULT 5,
      max_stock INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS imei_units (
      id TEXT PRIMARY KEY,
      variant_id TEXT NOT NULL REFERENCES product_variants(id),
      imei1 TEXT NOT NULL,
      imei2 TEXT,
      serial_number TEXT,
      lifecycle_status TEXT NOT NULL DEFAULT 'in_stock' CHECK (lifecycle_status IN ('ordered','received','in_stock','sold','returned','repair','traded_in','retired')),
      cost REAL NOT NULL DEFAULT 0,
      grade TEXT CHECK (grade IN ('new','A','B','C') OR grade IS NULL),
      received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      sold_at TEXT,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_imei_variant ON imei_units(variant_id);
    CREATE INDEX IF NOT EXISTS idx_imei_status ON imei_units(lifecycle_status);
    CREATE INDEX IF NOT EXISTS idx_imei1 ON imei_units(imei1);

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      variant_id TEXT NOT NULL REFERENCES product_variants(id),
      imei_unit_id TEXT,
      movement_type TEXT NOT NULL CHECK (movement_type IN ('purchase','sale','return','adjustment','inventory','transfer','loss','repair')),
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      quantity INTEGER NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      reference_type TEXT NOT NULL DEFAULT '',
      reference_id TEXT,
      user_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE INDEX IF NOT EXISTS idx_stock_variant ON stock_movements(variant_id);

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT,
      credit_limit REAL NOT NULL DEFAULT 50000,
      outstanding_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT,
      address TEXT,
      payment_terms TEXT NOT NULL DEFAULT 'comptant',
      balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      ticket_number TEXT NOT NULL,
      store_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      customer_id TEXT,
      subtotal REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','cancelled','on_credit','pending')),
      sale_date TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);
    CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id);
    CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);

    CREATE TABLE IF NOT EXISTS sale_lines (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      variant_id TEXT NOT NULL,
      imei_unit_id TEXT,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      unit_cost REAL NOT NULL,
      discount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sale_lines_sale ON sale_lines(sale_id);

    CREATE TABLE IF NOT EXISTS sale_payments (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','orange_money','mtn_momo','wave','card','transfer','credit','voucher')),
      amount REAL NOT NULL,
      reference TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id);

    CREATE TABLE IF NOT EXISTS cash_sessions (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      register_number INTEGER NOT NULL DEFAULT 1,
      opening_amount REAL NOT NULL DEFAULT 0,
      closing_amount REAL,
      expected_closing REAL,
      difference REAL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      opened_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      closed_at TEXT,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cash_session_user ON cash_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_cash_session_status ON cash_sessions(status);

    CREATE TABLE IF NOT EXISTS cash_movements (
      id TEXT PRIMARY KEY,
      cash_session_id TEXT NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
      movement_type TEXT NOT NULL CHECK (movement_type IN ('sale','expense','deposit','withdrawal','adjustment','opening')),
      payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','orange_money','mtn_momo','wave','card','transfer')),
      amount REAL NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      reference_type TEXT NOT NULL DEFAULT '',
      reference_id TEXT,
      user_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE INDEX IF NOT EXISTS idx_cash_mov_session ON cash_movements(cash_session_id);

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      description TEXT NOT NULL DEFAULT '',
      receipt_url TEXT,
      expense_date TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      account_debit TEXT NOT NULL,
      account_credit TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      reference_type TEXT NOT NULL DEFAULT '',
      reference_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(date);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_role TEXT NOT NULL,
      entity TEXT NOT NULL,
      action TEXT NOT NULL,
      before_data TEXT,
      after_data TEXT,
      sync_op_id TEXT,
      prev_hash TEXT,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_log(created_at);

    CREATE TABLE IF NOT EXISTS sync_ops (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('insert','update','delete','cancel')),
      record_id TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      logical_clock INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','synced','conflict','rejected')),
      error_message TEXT,
      actor_id TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      synced_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_ops(status);

    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS credit_plans (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id),
      customer_id TEXT NOT NULL,
      total_amount REAL NOT NULL,
      initial_payment REAL NOT NULL DEFAULT 0,
      remaining_amount REAL NOT NULL,
      installments_count INTEGER NOT NULL DEFAULT 3,
      installment_amount REAL NOT NULL,
      frequency_days INTEGER NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid','late')),
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS credit_installments (
      id TEXT PRIMARY KEY,
      credit_plan_id TEXT NOT NULL REFERENCES credit_plans(id) ON DELETE CASCADE,
      installment_number INTEGER NOT NULL,
      amount REAL NOT NULL,
      due_date TEXT NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      paid_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','late'))
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reference TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','partial','received','cancelled')),
      total_amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      extra_costs REAL NOT NULL DEFAULT 0,
      order_date TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      received_date TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS purchase_lines (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      variant_id TEXT NOT NULL,
      quantity_ordered INTEGER NOT NULL,
      quantity_received INTEGER NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL,
      line_total REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_purchase_lines_purchase ON purchase_lines(purchase_id);

    CREATE TABLE IF NOT EXISTS inventory_sessions (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','validated')),
      started_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      validated_at TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS trade_ins (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      variant_id TEXT,
      imei1 TEXT NOT NULL,
      imei2 TEXT,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      checklist TEXT NOT NULL DEFAULT '{}',
      photos TEXT NOT NULL DEFAULT '[]',
      estimated_cost REAL NOT NULL DEFAULT 0,
      grade TEXT NOT NULL DEFAULT 'C' CHECK (grade IN ('A','B','C')),
      status TEXT NOT NULL DEFAULT 'evaluated' CHECK (status IN ('evaluated','in_stock','sold','rejected')),
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);

  // Tenant hardening migration. Every business row is stamped with the active
  // store/tenant by the database, so legacy INSERT statements cannot omit it.
  await db.exec(`
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    UPDATE stores SET tenant_id = id WHERE tenant_id IS NULL;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_salt TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE imei_units ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE sale_lines ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE sync_ops ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE sync_ops ADD COLUMN IF NOT EXISTS actor_id TEXT;
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE credit_plans ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE credit_installments ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE inventory_sessions ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE trade_ins ADD COLUMN IF NOT EXISTS tenant_id TEXT;

    CREATE OR REPLACE FUNCTION teleboutik_stamp_tenant() RETURNS trigger AS $$
    DECLARE active_tenant TEXT;
    BEGIN
      IF TG_TABLE_NAME = 'stores' THEN
        NEW.tenant_id := NEW.id;
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE' AND OLD.tenant_id IS NOT NULL THEN
        NEW.tenant_id := OLD.tenant_id;
        RETURN NEW;
      END IF;
      SELECT value INTO active_tenant FROM app_meta WHERE key = 'active_tenant_id' LIMIT 1;
      IF active_tenant IS NULL OR active_tenant = '' THEN
        SELECT id INTO active_tenant FROM stores ORDER BY id LIMIT 1;
      END IF;
      IF NEW.tenant_id IS NULL OR NEW.tenant_id = '' THEN
        NEW.tenant_id := active_tenant;
      ELSIF active_tenant IS NOT NULL AND NEW.tenant_id <> active_tenant THEN
        RAISE EXCEPTION 'Tenant mismatch: row tenant differs from active tenant';
      END IF;
      IF NEW.tenant_id IS NULL THEN
        RAISE EXCEPTION 'No active tenant. Initialize a store before writing business data.';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DO $$ DECLARE t TEXT; BEGIN
      FOREACH t IN ARRAY ARRAY[
        'stores','users','products','product_variants','imei_units','stock_movements',
        'customers','suppliers','sales','sale_lines','sale_payments','cash_sessions',
        'cash_movements','expenses','journal_entries','audit_log','sync_ops','settings',
        'credit_plans','credit_installments','purchases','purchase_lines',
        'inventory_sessions','trade_ins'
      ] LOOP
        EXECUTE format('UPDATE %I SET tenant_id = (SELECT id FROM stores ORDER BY id LIMIT 1) WHERE tenant_id IS NULL AND EXISTS (SELECT 1 FROM stores)', t);
        EXECUTE format('DROP TRIGGER IF EXISTS tenant_stamp ON %I', t);
        EXECUTE format('CREATE TRIGGER tenant_stamp BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION teleboutik_stamp_tenant()', t);
      END LOOP;
    END $$;

    DROP TRIGGER IF EXISTS tenant_stamp ON stores;
    CREATE TRIGGER tenant_stamp BEFORE INSERT OR UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION teleboutik_stamp_tenant();

    CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_variants_tenant ON product_variants(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sales_tenant_date ON sales(tenant_id, sale_date);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant ON stock_movements(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_ops_tenant_status ON sync_ops(tenant_id, status);

    -- Durable outbox: every supported business INSERT/UPDATE is queued inside the
    -- same local transaction. PIN-bearing users and internal metadata are excluded.
    CREATE OR REPLACE FUNCTION teleboutik_enqueue_sync_op() RETURNS trigger AS $$
    DECLARE row_data JSONB;
    DECLARE row_id TEXT;
    DECLARE row_tenant TEXT;
    DECLARE op_kind TEXT;
    DECLARE next_clock BIGINT;
    BEGIN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      row_data := to_jsonb(NEW);
      IF TG_TABLE_NAME = 'users' THEN row_data := row_data - 'pin' - 'pin_hash' - 'pin_salt'; END IF;
      row_id := row_data ->> 'id';
      row_tenant := row_data ->> 'tenant_id';
      IF row_id IS NULL OR row_tenant IS NULL THEN
        RAISE EXCEPTION 'Cannot queue tenant-owned row without id and tenant_id';
      END IF;
      SELECT value INTO row_actor FROM app_meta WHERE key = 'active_user_id' LIMIT 1;
      IF TG_TABLE_NAME = 'users' AND (row_actor IS NULL OR row_actor = '') THEN row_actor := row_id; END IF;
      op_kind := CASE WHEN TG_OP = 'INSERT' THEN 'insert' ELSE 'update' END;
      SELECT COALESCE(MAX(logical_clock), 0) + 1 INTO next_clock
        FROM sync_ops WHERE tenant_id = row_tenant;
      INSERT INTO sync_ops (id, entity, operation, record_id, data, logical_clock, status, created_at, tenant_id, actor_id)
      VALUES (gen_random_uuid()::text, TG_TABLE_NAME, op_kind, row_id, row_data::text,
              next_clock, 'pending', CURRENT_TIMESTAMP, row_tenant, row_actor);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DO $$ DECLARE t TEXT; BEGIN
      FOREACH t IN ARRAY ARRAY[
        'users','products','product_variants','imei_units','stock_movements','customers','suppliers',
        'sales','sale_lines','sale_payments','cash_sessions','cash_movements','expenses',
        'journal_entries','audit_log','settings','credit_plans','credit_installments',
        'purchases','purchase_lines','inventory_sessions','trade_ins'
      ] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS sync_outbox ON %I', t);
        EXECUTE format('CREATE TRIGGER sync_outbox AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION teleboutik_enqueue_sync_op()', t);
      END LOOP;
    END $$;
  `);

  return db;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const database = await getDb();
  const result = await database.query(sql, params ?? []);
  return (result.rows ?? []) as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params?: unknown[]): Promise<void> {
  const database = await getDb();
  await database.query(sql, params ?? []);
}

export function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function now(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}
