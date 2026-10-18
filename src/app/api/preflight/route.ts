import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { systemPreflight } from '@/lib/system-preflight';
import { openDb, getSession, closeDb } from '@/lib/db';
export async function POST(req: NextRequest) {
  try {
    let leads = 0, searches = 1, enrich = true, workers = 0, openEnded = false;
    if (req.headers.get('content-type')?.includes('application/json')) {
      const { sessionId } = await req.json();
      if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) throw new Error('Ungültige Session-ID.');
      const db = openDb(sessionId);
      try {
        const session = getSession(db, sessionId);
        if (!session) throw new Error('Session nicht gefunden.');
        searches = session.total_jobs;
        leads = (db.prepare("select count(*) as n from places where enrich_status in ('pending','enriching')").get() as {n:number}).n;
        const unfinished = (db.prepare("select count(*) as n from jobs where status in ('pending','running')").get() as {n:number}).n;
        leads += unfinished * 200; openEnded = unfinished > 0;
        enrich = !!(session.search_email || session.search_owner); workers = session.worker_count;
      } finally { closeDb(sessionId); }
    } else {
      const form = await req.formData(); const file = form.get('file');
      if (!(file instanceof File) || file.size > 20 * 1024 * 1024) throw new Error('Bitte nutze eine Excel- oder CSV-Datei mit höchstens 20 MB.');
      const book = XLSX.read(await file.arrayBuffer());
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[book.SheetNames[0]]);
      const globalMax = Number(form.get('maxBusinesses')) || 60;
      const value = (row: Record<string, unknown>, names: string[]) => Object.entries(row).find(([k]) => names.includes(k.toLowerCase()))?.[1];
      const validRows = rows.filter(row => value(row,['stadt','city','ort','location','town']) && value(row,['branche','industry','category','keyword','niche','business']));
      if (!validRows.length) throw new Error('Keine gültigen Suchzeilen gefunden. Stadt und Branche sind erforderlich.');
      searches = validRows.length;
      for (const row of validRows) {
        const max = Number(value(row,['max','maximum','max_results','maxresults'])) || globalMax;
        if (max >= 100000 || max <= 0) { openEnded = true; leads += 200; }
        else leads += max;
      }
      enrich = form.get('searchEmail') === 'true' || form.get('searchOwner') === 'true';
      workers = form.get('singleWorker') === 'true' ? 1 : Number(form.get('enrichmentWorkerCount')) || 0;
    }
    return NextResponse.json(await systemPreflight({ leads, searches, enrich, workers, openEnded }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Ressourcencheck fehlgeschlagen.' }, { status: 400 }); }
}
