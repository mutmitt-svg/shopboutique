import { create } from 'zustand';
import type { User, CashSession, Store } from '../types';
import { hashPin, verifyPin } from '../lib/pin';
import { query, queryOne, execute, generateId, now } from '../db/localDb';
import { addSyncOp } from '../db/audit';

interface AuthState {
  user: User | null;
  store: Store | null;
  cashSession: CashSession | null;
  loginTime: number | null;
  isInitialized: boolean;
  init: () => Promise<void>;
  login: (pin: string) => Promise<boolean>;
  logout: () => void;
  checkSessionExpiry: () => boolean;
  setCashSession: (session: CashSession | null) => void;
  updateStore: (store: Store) => Promise<void>;
}

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  store: null,
  cashSession: null,
  loginTime: null,
  isInitialized: false,

  init: async () => {
    const stores = await query<Store>('SELECT * FROM stores ORDER BY id');
    // Fail closed: this release intentionally uses one local PGlite database per
    // tenant. Never silently pick the first tenant if multiple stores are found.
    if (stores.length > 1) {
      throw new Error('Plusieurs boutiques sont présentes dans la base locale. Séparez les données par tenant avant de continuer.');
    }
    const store = stores[0] ?? null;
    if (store?.id) {
      const tenantTables = ['users','products','product_variants','imei_units','stock_movements','customers','suppliers','sales','sale_lines','sale_payments','cash_sessions','cash_movements','expenses','journal_entries','audit_log','sync_ops','settings','credit_plans','credit_installments','purchases','purchase_lines','inventory_sessions','trade_ins'];
      for (const table of tenantTables) {
        const mismatch = await queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id IS NOT NULL AND tenant_id <> $1`, [store.id]);
        if ((mismatch?.count ?? 0) > 0) throw new Error(`Isolation multi-tenant : des données de ${table} appartiennent à un autre tenant. Migration manuelle requise.`);
      }
      // All subsequent local writes are stamped by the database with this tenant.
      await execute(
        `INSERT INTO app_meta (key, value) VALUES ('active_tenant_id', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [store.id]
      );
    }
    set({ store: store ?? null, isInitialized: true });
  },

  login: async (pin: string) => {
    const candidates = await query<User & { pin_hash?: string | null; pin_salt?: string | null; tenant_id: string }>(
      "SELECT * FROM users WHERE active = true AND tenant_id = (SELECT value FROM app_meta WHERE key = 'active_tenant_id')"
    );
    let user: (User & { pin_hash?: string | null; pin_salt?: string | null; tenant_id: string }) | null = null;
    for (const candidate of candidates) {
      if (candidate.pin_hash && candidate.pin_salt) {
        if (await verifyPin(pin, candidate.pin_salt, candidate.pin_hash)) { user = candidate; break; }
      } else if (candidate.pin === pin) {
        // Upgrade legacy plaintext PINs on the first successful login.
        const secure = await hashPin(pin);
        await execute('UPDATE users SET pin = $1, pin_hash = $2, pin_salt = $3 WHERE id = $4 AND tenant_id = $5', ['', secure.hash, secure.salt, candidate.id, candidate.tenant_id]);
        user = { ...candidate, pin: '', pin_hash: secure.hash, pin_salt: secure.salt };
        break;
      }
    }
    if (!user) return false;
    await execute("INSERT INTO app_meta (key, value) VALUES ('active_user_id', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [user.id]);
    if (user.role === 'owner') {
      const tenant = await queryOne<{ value: string }>("SELECT value FROM app_meta WHERE key = 'active_tenant_id'");
      const staff = await query<User & { tenant_id: string }>("SELECT * FROM users WHERE tenant_id = $1 AND active = true", [tenant?.value]);
      for (const member of staff) {
        const queued = await queryOne<{ id: string }>("SELECT id FROM sync_ops WHERE tenant_id = $1 AND entity = 'users' AND record_id = $2 LIMIT 1", [tenant?.value, member.id]);
        if (!queued) await addSyncOp('users', 'insert', member.id, { id: member.id, name: member.name, role: member.role, active: member.active, commission_rate: member.commission_rate, fixed_salary: member.fixed_salary, created_at: member.created_at });
      }
    }
    set({ user, loginTime: Date.now() });
    await execute(
      "INSERT INTO audit_log (id, user_id, user_role, entity, action, prev_hash, hash, created_at) VALUES ($1, $2, $3, 'auth', 'login', '', $4, $5)",
      [generateId(), user.id, user.role, hashString(`${user.id}-${Date.now()}`), now()]
    );
    return true;
  },

  logout: () => {
    const { user } = get();
    if (user) {
      execute(
        "INSERT INTO audit_log (id, user_id, user_role, entity, action, prev_hash, hash, created_at) VALUES ($1, $2, $3, 'auth', 'logout', '', $4, $5)",
        [generateId(), user.id, user.role, hashString(`${user.id}-${Date.now()}-out`), now()]
      );
    }
    execute("INSERT INTO app_meta (key, value) VALUES ('active_user_id', '') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value").catch(() => undefined);
    set({ user: null, cashSession: null, loginTime: null });
  },

  checkSessionExpiry: () => {
    const { loginTime } = get();
    if (!loginTime) return false;
    if (Date.now() - loginTime > SESSION_TIMEOUT_MS) {
      get().logout();
      return true;
    }
    return false;
  },

  setCashSession: (session) => set({ cashSession: session }),

  updateStore: async (store) => {
    await execute(
      `UPDATE stores SET name=$1, address=$2, phone=$3, currency=$4, currency_decimals=$5, tax_rate=$6, tax_enabled=$7, max_seller_discount=$8, max_manager_discount=$9, credit_limit_default=$10, return_window_days=$11, ticket_width=$12, footer_text=$13 WHERE id=$14 AND tenant_id = (SELECT value FROM app_meta WHERE key = 'active_tenant_id')`,
      [store.name, store.address, store.phone, store.currency, store.currency_decimals, store.tax_rate, store.tax_enabled, store.max_seller_discount, store.max_manager_discount, store.credit_limit_default, store.return_window_days, store.ticket_width, store.footer_text, store.id]
    );
    set({ store });
  },
}));

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}
