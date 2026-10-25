import { create } from 'zustand';
import { query, queryOne } from '../db/localDb';
import { synchronizePendingOperations } from '../db/syncService';

interface SyncState {
  isOnline: boolean;
  pendingCount: number;
  conflictCount: number;
  rejectedCount: number;
  lastSync: string | null;
  setOnline: (online: boolean) => void;
  refreshPendingCount: () => Promise<void>;
}

export const useSync = create<SyncState>((set) => ({
  isOnline: navigator.onLine,
  pendingCount: 0,
  conflictCount: 0,
  rejectedCount: 0,
  lastSync: null,

  setOnline: (online) => set({ isOnline: online }),

  refreshPendingCount: async () => {
    const tenant = await queryOne<{ value: string }>("SELECT value FROM app_meta WHERE key = 'active_tenant_id'");
    if (!tenant?.value) { set({ pendingCount: 0, conflictCount: 0, rejectedCount: 0 }); return; }
    const rows = await query<{ count: number }>(
      "SELECT COUNT(*) as count FROM sync_ops WHERE tenant_id = $1 AND status = 'pending'",
      [tenant.value]
    );
    const conflicts = await query<{ count: number }>("SELECT COUNT(*) as count FROM sync_ops WHERE tenant_id = $1 AND status = 'conflict'", [tenant.value]);
    const rejected = await query<{ count: number }>("SELECT COUNT(*) as count FROM sync_ops WHERE tenant_id = $1 AND status = 'rejected'", [tenant.value]);
    set({ pendingCount: Number(rows[0]?.count ?? 0), conflictCount: Number(conflicts[0]?.count ?? 0), rejectedCount: Number(rejected[0]?.count ?? 0) });
  },
}));

export function initSyncWatcher() {
  let disposed = false;
  const sync = async () => {
    if (disposed) return;
    useSync.getState().setOnline(navigator.onLine);
    try {
      if (navigator.onLine) await synchronizePendingOperations();
      await useSync.getState().refreshPendingCount();
    } catch (error) { console.warn('Synchronisation/état local reporté:', error); }
  };
  const onOnline = () => { void sync(); };
  const onVisible = () => { if (document.visibilityState === 'visible') void sync(); };
  const retryInterval = window.setInterval(() => { if (navigator.onLine) void sync(); }, 30000);
  document.addEventListener('visibilitychange', onVisible);
  const onOffline = () => useSync.getState().setOnline(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  void sync();
  return () => {
    disposed = true;
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
    window.clearInterval(retryInterval);
  };
}
