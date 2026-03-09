import { NextRequest, NextResponse } from 'next/server';
import { openDb, cancelSession } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const { sessionId } = await request.json();
    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
    }

    const db = openDb(sessionId);
    cancelSession(db, sessionId);

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: 'Failed to cancel session' }, { status: 500 });
  }
}
