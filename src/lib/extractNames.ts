// lib/extractNames.ts
export type ExtractOptions = {
  takeFirst?: boolean;        // wenn true: nur ersten Namen zurückgeben
  enableLooseLineScan?: boolean; // optional: zusätzliche vorsichtige Zeilen-Heuristik
};

const NON_PERSON_WORDS = [
  "restaurant", "restarant", "gastronomie", "hotel", "cafe", "café", "bar",
  "bistro", "imbiss", "pizzeria", "klause", "gmbh", "ug", "ag", "kg", "ohg", "gbr",
  "verein", "e.v.", "ltd", "inc"
];

const STOP_BY_DIGITS = /\d/; // Adressen etc. raus

// Sehr konservatives "Name"-Pattern:
// - Entweder "Herr/Frau X" (auch 1 Nachname) oder
// - "Vorname Nachname" (mind. 2 Wörter), jeweils mit Großbuchstaben-Anfang
const PERSON_WITH_TITLE_RE =
  /^(Herr|Frau)\s+[A-ZÄÖÜ][\p{L}'’\-]+(?:\s+[A-ZÄÖÜ][\p{L}'’\-]+){0,3}$/u;

const PERSON_NO_TITLE_RE =
  /^[A-ZÄÖÜ][\p{L}'’\-]+(?:\s+[A-ZÄÖÜ][\p{L}'’\-]+){1,3}$/u;

// Namen aus "Daniel Marquardt (Geschäftsführer)" extrahieren
const NAME_BEFORE_ROLE_PARENS_RE =
  /([A-ZÄÖÜ][\p{L}'’\-]+(?:\s+[A-ZÄÖÜ][\p{L}'’\-]+)+)\s*\((?:Geschäftsführer|GF|Inhaber|Betreiber|geschäftsführend[^)]*)\)/giu;

// Cue-Blöcke (deine Varianten inkl. Tippfehler "Vetreten")
const CUE_BLOCK_REGEXES: RegExp[] = [
  // Vertreten durch (auch "Vetreten")
  /(?:\bve(?:r)?treten\s+durch\b)(?:\s+den\s+[^:\n]{0,80})?\s*:?\s*([\s\S]{1,500}?)(?=\n\s*\n|\n\s*(?:Vertreten\s+durch|Verantwortlich|Inhaltlich\s+verantwortlich)\b|$)/gi,

  // Verantwortlich für den Inhalt nach § 55 ...
  /\bverantwortlich\s+im\s+sinne\s+von\s+§?\s*55\s*rstv\b\s*:?\s*([\s\S]{1,250}?)(?=\n\s*\n|$)/gi, 
  /\bverantwortlich\s+für\s+den\s+inhalt\b[^:\n]*:\s*([\s\S]{1,250}?)(?=\n\s*\n|$)/gi,

  // Verantwortlicher im Sinne von § 5 TMG
  /\bverantwortlich\w*\s+im\s+sinne\s+von\s+§?\s*5\s*tmg\b\s*:?\s*([\s\S]{1,250}?)(?=\n\s*\n|$)/gi,
  /\bverantwortlich\s+gemäß\s+§\s*5\s*tmg\b\s*:?\s*([\s\S]{1,250}?)(?=\n\s*\n|$)/gi,
  
  // Angaben gemäß § 5 TMG (mit unsichtbaren Zeichen und mehreren Umbrüchen)
  /\bangaben\s+gemäß\s+§\s*5\s*tmg\b\s*:?[\s\u200B-\u200D\uFEFF]*([\s\S]{1,250}?)(?=\n\s*\n|$)/gi,

  // Inhaltlich verantwortlicher gemäß ...
  /\binhaltlich\s+verantwortlich\w*\b[^:\n]*:\s*([\s\S]{1,250}?)(?=\n|$)/gi,

  // Geschäftsführer / Inhaber (explizite Label)
  /(?:\bGeschäftsführ(?:er|ung|erin|erinnen)\b|\bInhaber(?:in|inn?en)?\b)\s*:?\s*([\s\S]{1,250}?)(?=\n\s*\n|\n\s*[A-Z][^:]{0,30}:|\n\s*\d|$)/gi,

  // Ansprechpartner / Kontaktperson
  /(?:\bansprechpartner(?:in|innen)?\b|\bkontaktperson(?:en)?\b)\s*:?\s*([\s\S]{1,250}?)(?=\n\s*\n|\n\s*[A-Z][^:]{0,30}:|\n\s*\d|$)/gi,
];

function normalizeText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\u2013|\u2014/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeBusinessLine(s: string): boolean {
  const lower = s.toLowerCase();
  return NON_PERSON_WORDS.some(w => lower.includes(w));
}

function isLikelyPersonName(s: string): boolean {
  if (!s) return false;
  if (STOP_BY_DIGITS.test(s)) return false;
  if (looksLikeBusinessLine(s)) return false;
  if (/[/@]|https?:\/\//i.test(s)) return false;

  return PERSON_WITH_TITLE_RE.test(s) || PERSON_NO_TITLE_RE.test(s);
}

function cleanCandidate(raw: string): string {
  // Klammer-Rollen raus: "(Geschäftsführer)" etc.
  let s = raw.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  // Satzzeichen am Rand weg
  s = s.replace(/^[\s:,\-–—]+/, "").replace(/[\s,.;:]+$/, "").trim();
  // Mehrfachspaces
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

function splitCandidates(block: string): string[] {
  // Adress-Teil abschneiden: sobald eine Zeile mit Ziffern startet (Straße/PLZ)
  const lines = block.split("\n");
  let cutAtAddress = block;
  for (let i = 0; i < lines.length; i++) {
    // Wenn eine Zeile mit Ziffern beginnt (nach whitespace), dort abschneiden
    if (/^\s*\d/.test(lines[i])) {
      cutAtAddress = lines.slice(0, i).join("\n");
      break;
    }
  }

  // Trennzeichen: Komma / Semikolon / " und " / Zeilenumbrüche
  return cutAtAddress
    .split(/\s*(?:,|;|\bund\b|\n)\s*/i)
    .map(x => x.trim())
    .filter(Boolean);
}

function uniquePreserve(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of list) {
    const key = x.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(x);
    }
  }
  return out;
}

export function extractNames(text: string, opts: ExtractOptions = {}): string[] {
  const t = normalizeText(text);
  let names: string[] = [];

  // 1) High-precision: Namen vor Rollen-Klammern überall einsammeln
  for (const m of t.matchAll(NAME_BEFORE_ROLE_PARENS_RE)) {
    const cand = cleanCandidate(m[1] ?? "");
    if (isLikelyPersonName(cand)) names.push(cand);
  }

  // 2) Cue-Blöcke: "Vertreten durch:", "§55", "§5 TMG", etc.
  for (const re of CUE_BLOCK_REGEXES) {
    for (const m of t.matchAll(re)) {
      const block = (m[1] ?? "").trim();
      if (!block) continue;

      for (const part of splitCandidates(block)) {
        const cand = cleanCandidate(part);
        if (isLikelyPersonName(cand)) names.push(cand);
      }
    }
  }

  // 3) Optional: sehr vorsichtiger Zeilen-Scan (für Fälle wie "Restaurant XYZ\nHerr Eppel")
  if (opts.enableLooseLineScan) {
    const lines = t.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const cand = cleanCandidate(line);
      if (isLikelyPersonName(cand)) names.push(cand);
    }
  }

  names = uniquePreserve(names);

  if (opts.takeFirst && names.length > 0) return [names[0]];
  return names;
}
