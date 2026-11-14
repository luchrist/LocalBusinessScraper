'use client';
import type { PreflightReport } from '@/lib/system-preflight';
export default function PreflightDialog({ report, onDecision }: { report: PreflightReport; onDecision: (start: boolean) => void }) {
  const duration = (m: number) => m < 60 ? `${m} Min.` : `${Math.floor(m / 60)} Std. ${m % 60} Min.`;
  return <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"><section role="dialog" aria-modal="true" aria-labelledby="preflight-title" className="max-w-xl w-full max-h-[90vh] overflow-auto bg-white text-slate-900 rounded-2xl p-6 shadow-xl">
    <h2 id="preflight-title" className="text-xl font-bold mb-4">{report.warnings.length ? 'Bitte schließe zuerst andere Programme' : 'Dein Computer vor dem Start'}</h2>
    <p className="text-sm mb-4">RAM frei: <strong>{report.availableGb} von {report.totalGb} GB</strong> · CPU: <strong>{report.cpuPercent} %</strong> · {report.processCount} Prozesse</p>
    {report.warnings.map(w=><p key={w} className="bg-amber-50 text-amber-950 border border-amber-200 p-3 rounded-lg text-sm my-2">{w}</p>)}
    {report.busyProcesses.length > 0 && <div className="text-sm my-4"><p className="font-semibold mb-2">Aktuell ressourcenintensive Prozesse:</p><ul>{report.busyProcesses.map((p,i)=><li key={i} className="flex justify-between gap-3 py-1"><span className="truncate">{p.name}</span><span className="shrink-0 text-slate-500">{p.cpu} % CPU · {p.memoryMb} MB</span></li>)}</ul></div>}
    <div className="bg-indigo-50 rounded-xl p-4 my-4"><p className="font-semibold">Grobe Planung: {duration(report.minMinutes)} bis {duration(report.maxMinutes)}</p>
      <p className="text-sm mt-2">{report.openEnded ? `Bei unbegrenzter Suche: Beispielrechnung für rund ${report.estimatedLeads.toLocaleString('de-DE')} Leads. Die tatsächliche Dauer kann deutlich länger sein.` : `Für bis zu ${report.estimatedLeads.toLocaleString('de-DE')} angeforderte Leads.`}</p>
      <p className="text-xs text-slate-600 mt-2">Unverbindliche Schätzung. Hardware, Internet, Webseiten und Sperren können die Laufzeit stark verändern.</p></div>
    <p className="text-sm leading-relaxed">{report.recommendation}</p>
    <div className="flex gap-3 mt-6"><button autoFocus onClick={()=>onDecision(false)} className="border border-slate-300 rounded-xl px-4 py-3 flex-1">Zurück und Programme schließen</button><button onClick={()=>onDecision(true)} className="bg-indigo-600 text-white rounded-xl px-4 py-3 flex-1">{report.warnings.length ? 'Trotzdem starten' : 'Recherche starten'}</button></div>
  </section></div>;
}
