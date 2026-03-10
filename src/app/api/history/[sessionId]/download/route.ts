import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import * as XLSX from 'xlsx';
import { getAllPlaces } from '@/lib/db';
import { normalizeOwnerNameString } from '@/lib/owner-name-normalizer';

function isInitialOnly(name: string): boolean {
  // Matches a single letter (including umlauts) followed by a dot, e.g. "M."
  return /^[A-Za-z\u00C0-\u024F]\.$/.test(name.trim());
}

function classifyOwner(
  ownerSalutations: string | null,
  ownerFirstNames: string | null,
  ownerLastNames: string | null,
): { isAnredeNachname: boolean; isFirstnameNoAnrede: boolean } {
  const hasSalutation = !!(ownerSalutations?.trim());
  const hasLastName = !!(ownerLastNames?.trim());
  const firstNames = (ownerFirstNames ?? '').split('|').map(s => s.trim()).filter(Boolean);
  const hasAnyRealFirstName = firstNames.some(fn => !isInitialOnly(fn));
  const allFirstNamesAbsentOrInitial =
    firstNames.length === 0 || firstNames.every(fn => isInitialOnly(fn));
  return {
    isAnredeNachname: hasLastName && (hasSalutation || allFirstNamesAbsentOrInitial),
    isFirstnameNoAnrede: hasAnyRealFirstName && !hasSalutation,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const splitMode = new URL(request.url).searchParams.get('split') === 'true';
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

    if (splitMode) {
      const ohneNameRows = [] as typeof csvData;
      const ohneEmailRows = [] as typeof csvData;
      const anredeNachnameRows = [] as typeof csvData;
      const vornameOhneAnredeRows = [] as typeof csvData;

      for (let i = 0; i < places.length; i++) {
        const p = places[i];
        const row = csvData[i];
        const hasOwnerName = !!(row['Geschäftsführer Vorname']?.trim() || row['Geschäftsführer Nachname']?.trim());
        if (!hasOwnerName) ohneNameRows.push(row);
        if (!p.email?.trim()) ohneEmailRows.push(row);
        const { isAnredeNachname, isFirstnameNoAnrede } = classifyOwner(
          row['Anrede'],
          row['Geschäftsführer Vorname'],
          row['Geschäftsführer Nachname'],
        );
        if (isAnredeNachname) anredeNachnameRows.push(row);
        if (isFirstnameNoAnrede) vornameOhneAnredeRows.push(row);
      }

      const wbSplit = XLSX.utils.book_new();
      const appendSheet = (data: typeof csvData, name: string) => {
        XLSX.utils.book_append_sheet(wbSplit, XLSX.utils.json_to_sheet(data), name);
      };
      appendSheet(ohneNameRows, 'Ohne Name');
      appendSheet(ohneEmailRows, 'Ohne Email');
      appendSheet(anredeNachnameRows, 'Anrede + Nachname');
      appendSheet(vornameOhneAnredeRows, 'Vorname ohne Anrede');

      const xlsxBuffer = XLSX.write(wbSplit, { type: 'buffer', bookType: 'xlsx' });
      db.close();
      db = null;
      return new NextResponse(xlsxBuffer, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="results-split-${sessionId}.xlsx"`,
        },
      });
    }

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
