import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import * as XLSX from 'xlsx';
import { getAllPlaces } from '@/lib/db';
import { normalizeOwnerNameString } from '@/lib/owner-name-normalizer';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  if (!sessionId) {
    return NextResponse.json({ error: 'Session ID required' }, { status: 400 });
  }

  const dbPath = path.join(process.cwd(), 'scraper-data', `${sessionId}.db`);
  if (!fs.existsSync(dbPath)) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  let db: Database.Database | null = null;
  try {
    // Open in read-only mode to avoid locking or modifying
    // We use a new connection here instead of the shared pool to ensure we can close it immediately
    // and not affect any running scrapes (which would have their own connection in the pool if active).
    // SQLite supports multiple connections (WAL mode helps).
    db = new Database(dbPath, { readonly: true });
    
    // We can use the helper from db.ts, passing our local db instance
    const places = getAllPlaces(db, sessionId);

    const csvData = places.map((p: any) => {
      const fallback = normalizeOwnerNameString(p.owner);
      const ownerSalutations = p.owner_salutations ?? fallback.ownerSalutations;
      const ownerFirstNames = p.owner_first_names ?? fallback.ownerFirstNames;
      const ownerLastNames = p.owner_last_names ?? fallback.ownerLastNames;

      return {
      Stadt: p.stadt,
      Branche: p.branche,
      'Exakte Branche': p.exact_industry,
      Name: p.name,
      Adresse: p.address,
      Telefon: p.phone,
      Website: p.website,
      Email: p.email,
      'Anrede': ownerSalutations,
      'Geschäftsführer Vorname': ownerFirstNames,
      'Geschäftsführer Nachname': ownerLastNames,
      'Geschäftsführer': p.owner,
      Status: p.enrich_status,
      'Öffnungszeiten': p.hours,
      Preis: p.price,
      Bewertung: p.rating,
      'Anzahl Bewertungen': p.reviews,
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(csvData);
    XLSX.utils.book_append_sheet(wb, ws, 'Results');
    const csvBufferData = XLSX.write(wb, { type: 'buffer', bookType: 'csv' });
    const csvBuffer = Buffer.concat([Buffer.from('\xEF\xBB\xBF', 'binary'), csvBufferData]);

    db.close();
    db = null;

    return new NextResponse(csvBuffer, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="results-${sessionId}.csv"`,
      },
    });

  } catch (error) {
    console.error('Download error:', error);
    if (db) db.close();
    return NextResponse.json({ error: 'Failed to generate CSV' }, { status: 500 });
  }
}
