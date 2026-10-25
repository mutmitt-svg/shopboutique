import { FormEvent, useState } from 'react';
import { Store } from 'lucide-react';
import { execute, generateId, now } from '../db/localDb';
import { hashPin } from '../lib/pin';

export default function SetupPage() {
  const [name, setName] = useState('');
  const [ownerName, setOwnerName] = useState('Propriétaire');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (name.trim().length < 2) return setError('Le nom de la boutique doit contenir au moins 2 caractères.');
    if (!/^\d{4,6}$/.test(pin)) return setError('Le PIN doit contenir entre 4 et 6 chiffres.');
    if (pin !== confirmPin) return setError('Les deux PIN ne correspondent pas.');
    setBusy(true);
    try {
      const tenantId = generateId();
      const ownerId = generateId();
      const securePin = await hashPin(pin);
      await execute(`INSERT INTO stores (id, name, currency) VALUES ($1, $2, 'CDF')`, [tenantId, name.trim()]);
      await execute(`INSERT INTO app_meta (key, value) VALUES ('active_tenant_id', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [tenantId]);
      await execute(`INSERT INTO users (id, name, pin, pin_hash, pin_salt, role, active, commission_rate, fixed_salary, created_at) VALUES ($1, $2, '', $3, $4, 'owner', true, 0, 0, $5)`, [ownerId, ownerName.trim() || 'Propriétaire', securePin.hash, securePin.salt, now()]);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Impossible de créer la boutique.');
      setBusy(false);
    }
  }

  return <main className="min-h-screen flex items-center justify-center bg-slate-100 p-4"><form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4"><div className="text-center"><div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-100"><Store className="h-7 w-7 text-primary-700" /></div><h1 className="text-2xl font-bold">Bienvenue sur TeleBoutik</h1><p className="mt-1 text-sm text-slate-500">Créez le tenant de cette boutique pour commencer.</p></div><label className="block text-sm font-medium">Nom de la boutique<input className="input mt-1 w-full" value={name} onChange={e=>setName(e.target.value)} required maxLength={120} /></label><label className="block text-sm font-medium">Nom du propriétaire<input className="input mt-1 w-full" value={ownerName} onChange={e=>setOwnerName(e.target.value)} required maxLength={120} /></label><label className="block text-sm font-medium">PIN local (4 à 6 chiffres)<input className="input mt-1 w-full" inputMode="numeric" type="password" autoComplete="new-password" value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,'').slice(0,6))} required /></label><label className="block text-sm font-medium">Confirmer le PIN<input className="input mt-1 w-full" inputMode="numeric" type="password" autoComplete="new-password" value={confirmPin} onChange={e=>setConfirmPin(e.target.value.replace(/\D/g,'').slice(0,6))} required /></label>{error && <p role="alert" className="text-sm text-red-600">{error}</p>}<button disabled={busy} className="btn-primary w-full" type="submit">{busy ? 'Création…' : 'Créer ma boutique'}</button><p className="text-xs text-slate-500">Cette étape crée une boutique locale. Pour l'accès cloud distant, connectez ensuite un compte Supabase authentifié.</p></form></main>;
}
