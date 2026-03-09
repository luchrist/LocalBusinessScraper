import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { getAllPlaces, hasPendingPlaces, isSessionCancelled } from '@/lib/db';
import { normalizeOwnerNameString } from '@/lib/owner-name-normalizer';

/**
 * GET /api/scrape/snapshot?session=<sessionId>
 *
 * Returns all places collected so far plus session status, without
 * modifying any state. Used by the client after a sleep/reconnect to
 * reload the current progress without resuming the full scrape pipeline.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session');
  if (!sessionId) {
    return NextResponse.json({ error: 'session required' }, { status: 400 });
  }

  const dbPath = path.join(process.cwd(), 'scraper-data', `${sessionId}.db`);
  if (!fs.existsSync(dbPath)) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    const rawPlaces = getAllPlaces(db, sessionId);
    const stillRunning = hasPendingPlaces(db as any, sessionId);

    const results = rawPlaces.map((p: any) => {
      const fallback = normalizeOwnerNameString(p.owner);
      return {
        stadt: p.stadt,
        branche: p.branche,
        name: p.name,
        adresse: p.address ?? undefined,
        telefon: p.phone ?? undefined,
        website: p.website ?? undefined,
        email: p.email || undefined,
        owner: p.owner || undefined,
        ownerSalutations: p.owner_salutations ?? fallback.ownerSalutations ?? undefined,
        ownerFirstNames: p.owner_first_names ?? fallback.ownerFirstNames ?? undefined,
        ownerLastNames: p.owner_last_names ?? fallback.ownerLastNames ?? undefined,
        status: p.enrich_status,
        hours: p.hours ?? undefined,
        price: p.price ?? undefined,
        rating: p.rating ?? undefined,
        reviews: p.reviews ?? undefined,
      };
    });

    return NextResponse.json({ results, stillRunning });
  } catch (e) {
    return NextResponse.json({ error: 'Failed to load snapshot' }, { status: 500 });
  } finally {
    try { db?.close(); } catch {}
  }
}
