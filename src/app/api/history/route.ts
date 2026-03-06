import { NextResponse } from 'next/server';
import { listSessions } from '@/lib/db';

export async function GET() {
  try {
    const sessions = listSessions();
    // Sort by created_at descending (newest first)
    sessions.sort((a, b) => b.created_at - a.created_at);
    return NextResponse.json(sessions);
  } catch (error) {
    console.error('Failed to list sessions:', error);
    return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
  }
}
