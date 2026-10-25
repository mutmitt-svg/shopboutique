import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { initSyncWatcher } from './context/SyncContext';
import { getDb } from './db/localDb';
import SetupPage from './pages/SetupPage';
import LoginPage from './pages/LoginPage';
import POSPage from './pages/POSPage';
import DashboardPage from './pages/DashboardPage';
import StockPage from './pages/StockPage';
import SalesPage from './pages/SalesPage';
import CashPage from './pages/CashPage';
import AuditPage from './pages/AuditPage';
import SettingsPage from './pages/SettingsPage';
import CustomersPage from './pages/CustomersPage';
import AppLayout from './components/AppLayout';
import SyncStatusBar from './components/SyncStatusBar';
import RequireRole from './components/RequireRole';

export default function App() {
  const { user, store, isInitialized, init } = useAuth();
  const [dbReady, setDbReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await getDb();
        setDbReady(true);
        await init();
      } catch (err) {
        console.error('Init error:', err);
        setInitError(err instanceof Error ? err.message : String(err));
        setDbReady(true);
      }
    })();
    const stopSyncWatcher = initSyncWatcher();
    const interval = setInterval(() => {
      useAuth.getState().checkSessionExpiry();
    }, 60000);
    return () => { clearInterval(interval); stopSyncWatcher(); };
  }, []);

  if (!dbReady) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary-200 border-t-primary-600 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-500 text-sm">Chargement de TeleBoutik...</p>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50 p-4">
        <div className="text-center max-w-sm">
          <p className="text-error-600 font-semibold mb-2">Erreur d'initialisation</p>
          <p className="text-slate-500 text-sm mb-4">{initError}</p>
          <button
            onClick={() => { setInitError(null); setDbReady(false); window.location.reload(); }}
            className="btn-primary"
          >
            Réessayer
          </button>
        </div>
      </div>
    );
  }

  if (!store) return <SetupPage />;

  if (!user) {
    return <LoginPage />;
  }

  return (
    <BrowserRouter>
      <SyncStatusBar />
      <AppLayout>
        <Routes>
          <Route path="/" element={<Navigate to="/pos" replace />} />
          <Route path="/pos" element={<POSPage />} />
          <Route path="/dashboard" element={<RequireRole roles={['owner', 'manager', 'accountant']}><DashboardPage /></RequireRole>} />
          <Route path="/stock" element={<RequireRole roles={['owner', 'manager', 'seller']}><StockPage /></RequireRole>} />
          <Route path="/sales" element={<RequireRole roles={['owner', 'manager', 'seller', 'accountant']}><SalesPage /></RequireRole>} />
          <Route path="/cash" element={<RequireRole roles={['owner', 'manager', 'seller']}><CashPage /></RequireRole>} />
          <Route path="/customers" element={<RequireRole roles={['owner', 'manager', 'seller']}><CustomersPage /></RequireRole>} />
          <Route path="/audit" element={<RequireRole roles={['owner']}><AuditPage /></RequireRole>} />
          <Route path="/settings" element={<RequireRole roles={['owner', 'manager']}><SettingsPage /></RequireRole>} />
          <Route path="*" element={<Navigate to="/pos" replace />} />
        </Routes>
      </AppLayout>
    </BrowserRouter>
  );
}
