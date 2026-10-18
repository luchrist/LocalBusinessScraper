'use client';
import { useState, useEffect } from 'react';
export default function LicenseGate({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<boolean | null>(null);
  const [key, setKey] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  useEffect(() => { fetch('/api/license').then(r=>r.json()).then(d=>setActive(d.active)).catch(()=>setActive(false)); }, []);
  if (active) return <><div className="bg-indigo-950 px-4 py-2 text-white text-xs flex justify-between gap-4"><span>AutoSetter Lifetime · Lizenz aktiv</span><button disabled={loading} onClick={async () => {
    if (!window.confirm('Dieses Gerät freigeben? Danach kannst du deine Lizenz auf einem anderen Computer aktivieren. Beende vorher laufende Recherchen.')) return;
    setLoading(true);
    try { const res = await fetch('/api/license', { method:'DELETE' }); const d = await res.json(); if (!res.ok) throw new Error(d.error); setActive(false); }
    catch (e) { window.alert(e instanceof Error ? e.message : 'Freigabe fehlgeschlagen.'); } finally { setLoading(false); }
  }}>Gerät für Wechsel freigeben</button></div>{children}</>;
  return <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6"><div className="w-full max-w-lg rounded-3xl bg-slate-900 border border-indigo-500/30 p-8">
    <h1 className="text-3xl font-bold mb-3">AutoSetter freischalten</h1>
    {active === null ? <p>Lizenz wird geprüft …</p> : <>
      <p className="text-slate-300 mb-6">Gib den Lizenzschlüssel aus deiner Kaufbestätigung ein. Eine Lifetime-Lizenz aktiviert ein Gerät gleichzeitig.</p>
      <form onSubmit={async e => { e.preventDefault(); setLoading(true); setError('');
        try { const res = await fetch('/api/license', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key}) }); const d=await res.json(); if (!res.ok) throw new Error(d.error); setActive(true); }
        catch(e) {setError(e instanceof Error ? e.message : 'Aktivierung fehlgeschlagen.');} finally {setLoading(false);}
      }}>
        <label htmlFor="license-key" className="text-sm">Dein Lizenzschlüssel</label>
        <input id="license-key" required autoComplete="off" spellCheck={false} value={key} onChange={e=>setKey(e.target.value)} placeholder="ASET-XXXX-XXXX-XXXX" className="w-full rounded-xl border border-slate-600 bg-slate-950 p-3 my-3 font-mono" />
        <button disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-xl p-3 font-semibold">{loading ? 'Wird aktiviert …' : 'Lizenz aktivieren'}</button>
      </form>
      {error && <p role="alert" className="text-red-300 text-sm mt-4">{error}</p>}
      <a href="https://autosetter.de/#pricing" target="_blank" rel="noreferrer" className="block text-indigo-300 mt-6">Noch keine Lizenz? Lifetime kaufen →</a>
      <p className="text-slate-400 text-xs mt-4">Aktivierung und Start einer Recherche benötigen Internet.</p>
    </>}
  </div></main>;
}
