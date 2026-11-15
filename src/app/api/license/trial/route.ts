import { NextResponse } from 'next/server';
import { upgradeTrial, cancelTrial, TrialPaymentRequired } from '@/lib/app-license';
import { isRunning } from '@/lib/run-guard';
export async function POST() {
  try { await upgradeTrial(); return NextResponse.json({ paid: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Zahlung konnte nicht geprüft werden.', paymentUrl: error instanceof TrialPaymentRequired ? error.paymentUrl : undefined }, { status: 402 }); }
}
export async function DELETE() {
  if (isRunning()) return NextResponse.json({ error: 'Beende zuerst die laufende Recherche.' }, { status: 409 });
  try { await cancelTrial(); return NextResponse.json({ cancelled: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Test konnte nicht beendet werden.' }, { status: 409 }); }
}
