import { create } from 'zustand';
import { query } from '../db/localDb';
import { syncPendingOps, isSyncing } from '../db/syncEngine';

interface SyncState {
  isOnline: boolean;
  pendingCount: number;
  lastSync: string | null;
  isSyncing: boolean;
  lastSyncResult: { synced: number; failed: number } | null;
  setOnline: (online: boolean) => void;
  refreshPendingCount: () => Promise<void>;
  triggerSync: () => Promise<void>;
}

export const useSync = create<SyncState>((set, get) => ({
  isOnline: navigator.onLine,
  pendingCount: 0,
  lastSync: null,
  isSyncing: false,
  lastSyncResult: null,

  setOnline: (online) => {
    set({ isOnline: online });
    if (online && get().pendingCount > 0) {
      get().triggerSync();
    }
  },

  refreshPendingCount: async () => {
    const rows = await query<{ count: number }>(
      "SELECT COUNT(*) as count FROM sync_ops WHERE status = 'pending'"
    );
    set({ pendingCount: rows[0]?.count ?? 0 });
  },

  triggerSync: async () => {
    if (!navigator.onLine) return;
    if (isSyncing()) return;
    set({ isSyncing: true });
    try {
      const result = await syncPendingOps();
      set({
        lastSync: new Date().toISOString(),
        lastSyncResult: { synced: result.synced, failed: result.failed },
        isSyncing: false,
      });
      await get().refreshPendingCount();
    } catch {
      set({ isSyncing: false });
    }
  },
}));

export function initSyncWatcher() {
  const goOnline = () => {
    useSync.getState().setOnline(true);
    useSync.getState().refreshPendingCount();
    useSync.getState().triggerSync();
  };

  window.addEventListener('online', goOnline);
  window.addEventListener('offline', () => {
    useSync.getState().setOnline(false);
  });

  useSync.getState().refreshPendingCount();

  if (navigator.onLine) {
    useSync.getState().triggerSync();
  }

  setInterval(() => {
    if (navigator.onLine && useSync.getState().pendingCount > 0) {
      useSync.getState().triggerSync();
    }
  }, 30000);
}
