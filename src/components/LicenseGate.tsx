'use client';
import { useState, useEffect, useCallback } from 'react';
type License = { active: boolean; tier?: 'trial' | 'lifetime'; used?: number; limit?: number; priceCents?: number };
export default function LicenseGate({ children }: { children: React.ReactNode }) {
  const [license, setLicense] = useState<License | null>(null);
  const [key, setKey] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [paymentUrl, setPaymentUrl] = useState('');
  const refresh = useCallback(async () => { try { const response = await fetch('/api/license', { cache: 'no-store' }); setLicense(await response.json()); } catch { /* Keep the local UI during short service restarts. */ } }, []);
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 3000); return () => clearInterval(timer); }, [refresh]);
  if (license?.active) return <>
    <div className="bg-indigo-950 px-4 py-3 text-white text-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{license.tier === 'trial' ? `Kostenloser Test: ${license.used || 0} / 50 Ergebnisse · Ab Ergebnis 51 automatisch 299 € einmalig. Kein Abo.` : 'AutoSetter Lifetime · Auf diesem Computer aktiviert'}</span>
        {license.tier === 'trial' && <div className="flex flex-wrap gap-3">
          {(license.used || 0) >= 50 && <button disabled={loading} className="rounded-lg border border-indigo-300 px-3 py-2" onClick={async () => {
            setLoading(true); setError('');
            try { const response = await fetch('/api/license/trial', { method: 'POST' }); const data = await response.json();
              if (data.paymentUrl) setPaymentUrl(data.paymentUrl);
              if (!response.ok) throw new Error(data.error);
              setPaymentUrl(''); await refresh();
            } catch (e) { setError(e instanceof Error ? e.message : 'Zahlung wird geprüft.'); } finally { setLoading(false); }
          }}>Freischalten / Zahlung prüfen · 299 € einmalig</button>}
          <button disabled={loading} className="rounded-lg border border-indigo-300/40 px-3 py-2" onClick={async () => {
            if (!window.confirm('Kostenlosen Test beenden? Es werden dann keine weiteren Zahlungen über diesen Testzugang ausgelöst. Bereits gespeicherte Ergebnisse bleiben erhalten.')) return;
            setLoading(true); setError('');
            try { const response = await fetch('/api/license/trial', { method: 'DELETE' }); const data = await response.json(); if (!response.ok) throw new Error(data.error); await refresh(); }
            catch (e) { setError(e instanceof Error ? e.message : 'Test konnte nicht beendet werden.'); } finally { setLoading(false); }
          }}>Test beenden</button>
        </div>}
      </div>
      {error && <p role="alert" className="mt-2 text-amber-200">{error}</p>}
      {paymentUrl && <a className="mt-3 inline-block rounded-lg bg-white px-4 py-2 font-semibold text-indigo-950" href={paymentUrl} target="_blank" rel="noreferrer">Zahlung bei der Bank bestätigen →</a>}
    </div>
    {children}
  </>;
  return <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6"><div className="w-full max-w-lg rounded-3xl bg-slate-900 border border-indigo-500/30 p-8">
    <h1 className="text-3xl font-bold mb-3">AutoSetter freischalten</h1>
    {license === null ? <p>Freischaltung wird geprüft …</p> : <>
      <p className="text-slate-300 mb-6">Gib deinen Testschlüssel oder gekauften Lizenzschlüssel ein. Der Zugang wird an diesen Computer gebunden.</p>
      <form onSubmit={async event => { event.preventDefault(); setLoading(true); setError('');
        try { const response = await fetch('/api/license', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); await refresh(); }
        catch (e) { setError(e instanceof Error ? e.message : 'Aktivierung fehlgeschlagen.'); } finally { setLoading(false); }
      }}>
        <label htmlFor="license-key" className="text-sm">Dein Test- oder Lizenzschlüssel</label>
        <input id="license-key" required autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="ASET-XXXX-XXXX-XXXX" className="w-full rounded-xl border border-slate-600 bg-slate-950 p-3 my-3 font-mono" />
        <button disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-xl p-3 font-semibold">{loading ? 'Wird aktiviert …' : 'AutoSetter aktivieren'}</button>
      </form>
      {error && <p role="alert" className="text-red-300 text-sm mt-4">{error}</p>}
      <a href="https://www.autosetter.de/#pricing" target="_blank" rel="noreferrer" className="block text-indigo-300 mt-6">50 Ergebnisse kostenlos testen →</a>
      <p className="text-slate-400 text-xs mt-4">Karte zu Beginn bestätigen, 50 Ergebnisse kostenlos. Bei weiterer Nutzung ab Ergebnis 51 automatisch 299 € einmalig. Nach der Bezahlung wird die Lizenz lokal geprüft.</p>
    </>}
  </div></main>;
}
