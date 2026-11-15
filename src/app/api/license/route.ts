import { trialUsage } from '@/lib/trial-usage';
import { isRunning } from '@/lib/run-guard';
import { NextRequest, NextResponse } from 'next/server';
import { licenseAccess, activateLicense } from '@/lib/app-license';
export async function GET() {
  try { const access = await licenseAccess(); return NextResponse.json({ active: true, ...access, used: access.tier === 'trial' ? await trialUsage(access.id) : undefined }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ active: false }, { headers: { 'Cache-Control': 'no-store' } }); }
}
export async function POST(req: NextRequest) {
  if (isRunning()) return NextResponse.json({ error: 'Beende zuerst die laufende Recherche.' }, { status: 409 });
  try {
    const body = await req.json();
    const key = typeof body?.key === 'string' ? body.key.trim().toUpperCase() : '';
    if (!/^ASET-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(key)) return NextResponse.json({ error: 'Bitte gib einen gültigen Lizenzschlüssel ein.' }, { status: 400 });
    await activateLicense(key); return NextResponse.json({ active: true });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Aktivierung fehlgeschlagen.' }, { status: 403 }); }
}
export async function DELETE() {
  return NextResponse.json({ error: 'Die Lizenz ist dauerhaft an diesen Computer gebunden. Bitte kontaktiere den Support.' }, { status: 409 });
}
