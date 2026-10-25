import { Wifi, WifiOff, CloudUpload, AlertTriangle } from 'lucide-react';
import { useSync } from '../context/SyncContext';

export default function SyncStatusBar() {
  const { isOnline, pendingCount, conflictCount, rejectedCount } = useSync();

  if (isOnline && pendingCount === 0 && conflictCount === 0 && rejectedCount === 0) return null;

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-[60] px-4 py-1.5 text-center text-xs font-medium flex items-center justify-center gap-2 ${
        isOnline
          ? 'bg-primary-600 text-white'
          : 'bg-warning-500 text-white'
      }`}
    >
      {conflictCount > 0 || rejectedCount > 0 ? (
        <>
          <AlertTriangle className="w-3.5 h-3.5" />
          {conflictCount} conflit(s) · {rejectedCount} rejet(s) à examiner
        </>
      ) : isOnline ? (
        <>
          <CloudUpload className="w-3.5 h-3.5" />
          {pendingCount > 0 ? `${pendingCount} opération(s) en cours de synchronisation...` : 'Synchronisé'}
        </>
      ) : (
        <>
          <WifiOff className="w-3.5 h-3.5" />
          Hors ligne — {pendingCount > 0 ? `${pendingCount} opération(s) en attente` : 'données locales'}
        </>
      )}
    </div>
  );
}
