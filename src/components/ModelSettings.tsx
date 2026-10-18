'use client';
import { useEffect, useState } from 'react';
declare global { interface Window { autosetter?: { chooseModel: () => Promise<string | null> } } }
export default function ModelSettings() {
  const [path,setPath]=useState(''); const [available,setAvailable]=useState(false); const [message,setMessage]=useState('');
  useEffect(()=>{fetch('/api/settings/model').then(r=>r.json()).then(d=>{setPath(d.path);setAvailable(d.available);}).catch(()=>{});},[]);
  async function save(value:string) {
    try {const res=await fetch('/api/settings/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:value})});const d=await res.json();if(!res.ok)throw new Error(d.error);setPath(value);setAvailable(!!value);setMessage('Modell gespeichert.');}
    catch(e){setMessage(e instanceof Error?e.message:'Speichern fehlgeschlagen.');}
  }
  return <section className="mb-8 border border-indigo-200 bg-indigo-50 rounded-xl p-5 text-slate-800">
    <h3 className="font-semibold mb-2">Lokale KI für schwierige Inhabernamen (optional)</h3>
    <p className="text-sm mb-3">{available?'Modell eingerichtet.':'Kein KI-Modell gefunden. Standard-Recherche und regelbasierte Namenserkennung funktionieren weiter. Für zusätzliche KI-Erkennung wähle ein kompatibles lokales GGUF-Instruct-Modell.'}</p>
    <label htmlFor="model-path" className="text-sm">Lokaler Pfad zur GGUF-Datei</label>
    <input id="model-path" value={path} onChange={e=>setPath(e.target.value)} placeholder="/Pfad/zum/Modell.gguf" className="w-full border border-slate-300 bg-white rounded-lg p-2 my-2 text-sm" />
    <div className="flex gap-3"><button className="bg-indigo-600 text-white rounded-lg px-3 py-2 text-sm" onClick={()=>save(path)}>Modell speichern</button><button className="border border-indigo-300 rounded-lg px-3 py-2 text-sm" onClick={async()=>{if(!window.autosetter){setMessage('Trage den Dateipfad oben ein.');return;}const file=await window.autosetter.chooseModel();if(file)await save(file);}}>Datei auswählen</button></div>
    {message&&<p role="status" className="mt-3 text-sm">{message}</p>}
  </section>;
}
