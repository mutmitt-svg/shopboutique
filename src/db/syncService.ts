import { requireSupabase } from '../lib/supabase';
import { execute, query, queryOne, now } from './localDb';
import type { SyncOp } from '../types';

const ENTITY_ORDER: Record<string, number> = {
  users: 1,
  products: 10,
  product_variants: 20,
  imei_units: 30,
  customers: 30,
  suppliers: 30,
  sales: 40,
  sale_lines: 50,
  sale_payments: 60,
  stock_movements: 70,
  cash_sessions: 70,
  cash_movements: 80,
  expenses: 80,
  journal_entries: 90,
  credit_plans: 90,
  credit_installments: 100,
  purchases: 40,
  purchase_lines: 50,
  inventory_sessions: 40,
  trade_ins: 50,
  settings: 90,
  audit_log: 100,
};

let syncPromise: Promise<void> | null = null;

function isConflictError(message: string): boolean {
  return /conflict|tenant mismatch|version|duplicate key|already exists/i.test(message);
}

/**
 * Sends durable local operations to the tenant-validated server RPC.
 * The RPC is idempotent; retrying an operation cannot create a duplicate sale.
 */
export function synchronizePendingOperations(): Promise<void> {
  if (syncPromise) return syncPromise;
  syncPromise = runSync().finally(() => { syncPromise = null; });
  return syncPromise;
}

async function runSync(): Promise<void> {
  if (!navigator.onLine) return;
  const tenant = await queryOne<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = 'active_tenant_id'"
  );
  if (!tenant?.value) return;

  const supabase = requireSupabase();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session) return; // Keep local work queued until cloud login exists.

  const operations = await query<SyncOp & { tenant_id: string; actor_id: string | null }>(
    `SELECT id, entity, operation, record_id, data, logical_clock, status,
            error_message, created_at, synced_at, tenant_id, actor_id
       FROM sync_ops
      WHERE tenant_id = $1 AND status = 'pending'
      ORDER BY logical_clock ASC, created_at ASC`,
    [tenant.value]
  );
  operations.sort((a, b) =>
    (ENTITY_ORDER[a.entity] ?? 500) - (ENTITY_ORDER[b.entity] ?? 500) ||
    a.logical_clock - b.logical_clock
  );

  for (const op of operations) {
    if (!navigator.onLine) break;
    try {
      const payload = JSON.parse(op.data || '{}') as Record<string, unknown>;
      // Employee PINs are never synchronized. User provisioning must use a dedicated
      // authenticated workflow and a server-side PIN verifier.
      if (Object.prototype.hasOwnProperty.call(payload, 'pin') || Object.prototype.hasOwnProperty.call(payload, 'pin_hash') || Object.prototype.hasOwnProperty.call(payload, 'pin_salt')) {
        await execute(
          "UPDATE sync_ops SET status = 'rejected', error_message = $1 WHERE id = $2 AND tenant_id = $3",
          ['Les identifiants locaux ne sont jamais synchronisés.', op.id, tenant.value]
        );
        continue;
      }

      let cloudPayload = payload;
      if (op.entity === 'imei_units' && op.operation === 'update') {
        cloudPayload = { id: payload.id ?? op.record_id, lifecycle_status: payload.lifecycle_status, sold_at: payload.sold_at };
      }

      const { error } = await supabase.rpc('apply_sync_operation', {
        p_operation_id: op.id,
        p_store_id: tenant.value,
        p_entity: op.entity,
        p_operation: op.operation,
        p_record_id: op.record_id,
        p_payload: cloudPayload,
        p_actor_id: op.actor_id ?? (op.entity === 'users' ? op.record_id : null),
        p_base_version: null,
      });
      if (error) throw error;

      await execute(
        "UPDATE sync_ops SET status = 'synced', synced_at = $1, error_message = NULL WHERE id = $2 AND tenant_id = $3",
        [now(), op.id, tenant.value]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = isConflictError(message) ? 'conflict' : 'pending';
      await execute(
        'UPDATE sync_ops SET status = $1, error_message = $2 WHERE id = $3 AND tenant_id = $4',
        [status, message.slice(0, 1000), op.id, tenant.value]
      );
      // Preserve order: do not send dependent records after a failed parent operation.
      break;
    }
  }
}
