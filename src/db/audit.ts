import { queryOne, execute, generateId, now } from './localDb';
import type { User } from '../types';

export async function addAuditLog(
  user: User,
  entity: string,
  action: string,
  beforeData: unknown = null,
  afterData: unknown = null
): Promise<void> {
  const before = beforeData ? JSON.stringify(beforeData) : null;
  const after = afterData ? JSON.stringify(afterData) : null;

  const tenant = await queryOne<{ value: string }>("SELECT value FROM app_meta WHERE key = 'active_tenant_id'");
  if (!tenant?.value) throw new Error('Journal d’audit impossible sans tenant actif.');
  const lastLog = await queryOne<{ hash: string }>(
    'SELECT hash FROM audit_log WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1',
    [tenant.value]
  );
  const prevHash = lastLog?.hash ?? '';
  const content = `${prevHash}|${user.id}|${entity}|${action}|${before ?? ''}|${after ?? ''}`;
  const hash = simpleHash(content);

  await execute(
    `INSERT INTO audit_log (id, user_id, user_role, entity, action, before_data, after_data, prev_hash, hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [generateId(), user.id, user.role, entity, action, before, after, prevHash, hash, now()]
  );
}

export async function addSyncOp(
  entity: string,
  operation: 'insert' | 'update' | 'delete' | 'cancel',
  recordId: string,
  data: unknown
): Promise<void> {
  const tenant = await queryOne<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = 'active_tenant_id'"
  );
  if (!tenant?.value) throw new Error('Impossible de créer une opération sans tenant actif.');
  const clockRow = await queryOne<{ max_clock: number }>(
    'SELECT COALESCE(MAX(logical_clock), 0) as max_clock FROM sync_ops WHERE tenant_id = $1',
    [tenant.value]
  );
  const clock = (clockRow?.max_clock ?? 0) + 1;

  await execute(
    `INSERT INTO sync_ops (id, entity, operation, record_id, data, logical_clock, status, created_at, tenant_id, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)`,
    [generateId(), entity, operation, recordId, JSON.stringify(data), clock, now(), tenant.value, (await queryOne<{ value: string }>("SELECT value FROM app_meta WHERE key = 'active_user_id'"))?.value || null]
  );
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(16, '0');
}
