import { NextRequest, NextResponse } from 'next/server';
import { getModelPath, saveModelPath } from '@/lib/model-settings';
import { shutdownWorker } from '@/lib/llm-extractor';
import { isRunning } from '@/lib/run-guard';
import fs from 'node:fs/promises';
export async function GET() {
  const path = await getModelPath();
  const available = path ? await fs.access(path).then(()=>true).catch(()=>false) : false;
  return NextResponse.json({ path, available });
}
export async function POST(req: NextRequest) {
  if (isRunning()) return NextResponse.json({ error: 'Bitte beende zuerst die laufende Recherche.' }, { status:409 });
  try { const { path } = await req.json(); if (typeof path !== 'string') throw new Error('Ungültiger Modellpfad.'); await saveModelPath(path); await shutdownWorker(); return NextResponse.json({ ok:true }); }
  catch(e) { return NextResponse.json({ error:e instanceof Error ? e.message : 'Modell konnte nicht eingerichtet werden.' },{status:400}); }
}
