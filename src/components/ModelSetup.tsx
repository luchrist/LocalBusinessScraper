'use client';
import { useEffect, useState } from 'react';
type State = { status: string; model: string; received: number; total: number; error?: string };
export default function ModelSetup() {
  const [state, setState] = useState<State | null>(null);
  useEffect(() => {
    let active = true;
    const update = async (method = 'GET') => {
      try { const response = await fetch('/api/settings/model/setup', { method, cache: 'no-store' }); const data = await response.json(); if (active) setState(data); } catch { /* The next poll retries a restarting local service. */ }
    };
    void update('POST');
    const timer = setInterval(() => void update(), 1500);
    return () => { active = false; clearInterval(timer); };
  }, []);
  if (!state || state.status === 'ready') return null;
  const percent = state.total ? Math.min(100, Math.floor(state.received / state.total * 100)) : 0;
  return <aside className="border-b border-indigo-400/30 bg-indigo-950 px-5 py-4 text-white" aria-live="polite">
    <div className="mx-auto max-w-5xl">
      <p className="text-sm font-semibold">{state.status === 'error' ? 'KI-Einrichtung unterbrochen' : state.status === 'verifying' ? 'Lokales KI-Modell wird geprüft …' : 'AutoSetter richtet deine lokale KI ein'}</p>
      <p className="mt-1 text-xs text-indigo-200">{state.error || `${state.model} · ${percent} % · Das passende Modell wird einmalig heruntergeladen und läuft anschließend auf deinem Computer.`}</p>
      {state.status === 'error' ? <button className="mt-3 rounded-lg border border-indigo-300 px-3 py-2 text-xs" onClick={async () => { const r = await fetch('/api/settings/model/setup', { method: 'POST' }); setState(await r.json()); }}>Download fortsetzen</button> :
        <progress max={100} value={percent} className="mt-3 h-1.5 w-full accent-indigo-400" aria-label="KI-Modell herunterladen" />}
    </div>
  </aside>;
}
