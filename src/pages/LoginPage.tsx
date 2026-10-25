import { useState, useEffect } from 'react';
import { Store, Delete } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';

export default function LoginPage() {
  const { login, store } = useAuth();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [cloudMode, setCloudMode] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [cloudMessage, setCloudMessage] = useState('');

  useEffect(() => {
    if (pin.length >= 4) {
      handleSubmit();
    }
  }, [pin]);

  const handleSubmit = async () => {
    if (pin.length < 4) return;
    const success = await login(pin);
    if (!success) {
      setError('Code PIN incorrect');
      setPin('');
    }
  };

  const handleCloudLogin = async () => {
    setCloudMessage('');
    if (!supabase) return setCloudMessage('Supabase n’est pas configuré.');
    const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (authError) return setCloudMessage(authError.message);
    if (!store) {
      await supabase.auth.signOut();
      return setCloudMessage('Aucune boutique locale à associer à ce compte.');
    }
    const { error: linkError } = await supabase.rpc('register_local_store', {
      p_store_id: store.id,
      p_name: store.name,
      p_address: store.address ?? '',
      p_phone: store.phone ?? '',
      p_currency: store.currency ?? 'CDF',
    });
    if (linkError) {
      await supabase.auth.signOut();
      return setCloudMessage(`Association du tenant refusée : ${linkError.message}`);
    }
    setCloudMessage('Compte cloud connecté et tenant associé. La synchronisation reprendra automatiquement.');
    window.setTimeout(() => window.location.reload(), 500);
  };

  const handleKey = (key: string) => {
    if (pin.length >= 6) return;
    setError('');
    setPin(pin + key);
  };

  const handleDelete = () => {
    setError('');
    setPin(pin.slice(0, -1));
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-700 to-primary-900 p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
            <Store className="w-8 h-8 text-primary-700" />
          </div>
          <h1 className="text-2xl font-bold text-white">TeleBoutik POS</h1>
          <p className="text-primary-200 text-sm mt-1">{store?.name ?? 'Boutique'}</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-6">
          <p className="text-center text-slate-600 text-sm mb-4">Entrez votre code PIN</p>

          <div className="flex justify-center gap-2 mb-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className={`w-3 h-3 rounded-full transition-all ${
                  i < pin.length ? 'bg-primary-600 scale-110' : 'bg-slate-200'
                }`}
              />
            ))}
          </div>

          {error && (
            <p className="text-center text-error-600 text-sm mb-3 animate-fade-in">{error}</p>
          )}

          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => (
              <button
                key={key}
                onClick={() => handleKey(key)}
                className="aspect-square rounded-xl bg-slate-50 hover:bg-primary-50 active:bg-primary-100 text-xl font-semibold text-slate-700 transition-all active:scale-95"
              >
                {key}
              </button>
            ))}
            <div />
            <button
              onClick={() => handleKey('0')}
              className="aspect-square rounded-xl bg-slate-50 hover:bg-primary-50 active:bg-primary-100 text-xl font-semibold text-slate-700 transition-all active:scale-95"
            >
              0
            </button>
            <button
              onClick={handleDelete}
              className="aspect-square rounded-xl bg-slate-50 hover:bg-error-50 active:bg-error-100 flex items-center justify-center text-slate-500 transition-all active:scale-95"
            >
              <Delete className="w-5 h-5" />
            </button>
          </div>

          <div className="mt-4 pt-4 border-t border-slate-100 text-center">
            <button type="button" className="text-sm font-medium text-primary-700" onClick={() => setCloudMode(v => !v)}>
              {cloudMode ? 'Masquer la connexion cloud' : 'Connexion du compte cloud (synchronisation)'}
            </button>
            {cloudMode && <div className="mt-3 space-y-2 text-left">
              <label className="block text-xs font-medium text-slate-600">E-mail cloud<input className="input mt-1 w-full" type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} /></label>
              <label className="block text-xs font-medium text-slate-600">Mot de passe<input className="input mt-1 w-full" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} /></label>
              <button type="button" className="btn-primary w-full" onClick={handleCloudLogin}>Connecter le compte cloud</button>
              {cloudMessage && <p role="status" className="text-xs text-slate-600">{cloudMessage}</p>}
            </div>}
            <p className="mt-3 text-xs text-slate-400">Le PIN local sert à ouvrir la caisse sur cet appareil. Le compte cloud authentifie l’accès distant et la synchronisation.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
