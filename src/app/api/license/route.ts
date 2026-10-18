import { isRunning } from '@/lib/run-guard';
import { NextRequest, NextResponse } from 'next/server';
import { requireLicense, activateLicense, deactivateLicense } from '@/lib/app-license';
export async function GET() {
  try { await requireLicense(); return NextResponse.json({ active: true }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ active: false }, { headers: { 'Cache-Control': 'no-store' } }); }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const key = typeof body?.key === 'string' ? body.key.trim().toUpperCase() : '';
    if (!/^ASET-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(key)) return NextResponse.json({ error: 'Bitte gib einen gültigen Lizenzschlüssel ein.' }, { status: 400 });
    await activateLicense(key); return NextResponse.json({ active: true });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Aktivierung fehlgeschlagen.' }, { status: 403 }); }
}
export async function DELETE() {
  if (isRunning()) return NextResponse.json({ error: 'Beende zuerst die laufende Recherche.' }, { status:409 });
  try { await deactivateLicense(); return NextResponse.json({ active: false }); }
  catch { return NextResponse.json({ error: 'Gerät konnte nicht freigegeben werden. Bitte prüfe deine Internetverbindung.' }, { status: 503 }); }
}
