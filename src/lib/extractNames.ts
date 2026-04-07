// lib/extractNames.ts
export type ExtractOptions = {
  takeFirst?: boolean;        // wenn true: nur ersten Namen zurückgeben
  enableLooseLineScan?: boolean; // optional: zusätzliche vorsichtige Zeilen-Heuristik
  placeCity?: string; // optionale Stadt aus dem Place-Kontext, wird als Name geblockt
};

export type PendingNameDisambiguation = {
  line1: string;
  line2: string;
  cueLabel: string;
};

export type ExtractNamesDetailedResult = {
  names: string[];
  pendingDisambiguations: PendingNameDisambiguation[];
};

const NON_PERSON_WORDS = [
  "restaurant", "restarant", "gastronomie", "hotel", "cafe", "café", "bar",
  "bistro", "imbiss", "pizzeria", "klause", "gmbh", "ug", "ag", "kg", "ohg", "gbr",
  "verein", "e.v.", "ev", "ltd", "inc", "club", "vfr", "sv", "fc", "fv"
];

// Einzelne Wörter, die niemals Teil eines Personennamens sind (token-genau, lowercase)
const NON_NAME_TOKENS = new Set([
  // Bewertungs-/Rating-Labels (typisch auf Verzeichnisseiten wie dotlo, Google etc.)
  "preis", "leistung", "qualität", "atmosphäre", "ambiente", "bewertung",
  "service", "sauberkeit", "freundlichkeit", "stimmung",
  // Sonstige häufige Substantive, die kein Namensbestandteil sind
  "öffnungszeiten", "adresse", "telefon", "webseite", "kontakt",
  "speisekarte", "angebot", "produkt", "küche", "aufsichtsbehörde", "richtigkeit",
  "konzeption", "design", "programmierung", "hosting", "domain", "beratung",
  "catering", "haftung", "food", "drink", "e-mail", "email", "bankverbindung",
  "vorarlberg", "voralberg", "realisierung", "trattoria",
  // Rollen-/Organisationsbegriffe, die kein Namensbestandteil sind
  "gf", "geschäftsführer", "geschaeftsfuehrer", "geschäftsführung", "geschaeftsfuehrung",
  "inhaber", "inhaberin", "registergericht", "amtsgericht", "finanzamt",
  "ristorante", "gasthaus", "landeshauptstadt", "streitbeilegungsstelle", "datenschutzbeauftragte", "datenschutzbeauftragter", "streitschlichtung"
  ,
  // Zusätzliche hart geblockte Wörter (dürfen auch nicht als Namensbestandteil vorkommen)
  "digital", "besitzer", "allgemein", "nützlich", "nuetzlich", "technisch",
  "zusätzlich", "zusaetzlich", "schloss", "wirtschaft", "gasthof", "wirtshaus",
  "inhalt", "internet", "werbung", "historisch", "fachbareich", "autohof",
  "gesellschafter", "ordnungsamt", "weiterführend", "weiterfuehrend", "kino",
  "gewerbeamt", "betriebsstätte", "betriebsstaette", "zuständig", "zustaendig",
  "stübchen", "stuebchen", "stube", "mountain", "eigene", "lizens", "unsere",
  "haftungshinweis", "serviceleistung",
  // Exakt geblockte Einzelwörter
  "für", "fuer", "view", "film"
]);

const BLOCKED_NAME_PATTERNS: RegExp[] = [
  /\bgasthof\w*\b/iu,
  /\bgoogle\s+analytics\b/iu,
  /\bumsatzsteuer\s*-?\s*ident\w*\b/iu,
  /\bregistergericht\b/iu,
  /\bamtsgericht\b/iu,
  /\bfinanzamt\b/iu,
  /\bgeschäftsführung\b/iu,
  /\bgeschaeftsfuehrung\b/iu,
  /\bgasthaus\b/iu,
  /\bristorante\b/iu,
  /\btrattoria\b/iu,
  /\binhaber\b/iu,
  /\bgf\b/iu,
  /\bstadt\w*\b/iu,
  /\baufsichtsbeh(?:o|ö)rde\b/iu,
  /\brechtliche\s+hinweise\b/iu,
  /\brichtigkeit\b/iu,
  /\bkonzeption\b/iu,
  /\bdesign\b/iu,
  /\bprogrammierung\b/iu,
  /\bhosting\b/iu,
  /\bdomain\b/iu,
  /\bberatung\b/iu,
  /\bcatering\b/iu,
  /\bhaftung(?:\s+f(?:u|ü)r\s+inhalte)?\b/iu,
  /\bfood\b/iu,
  /\bdrink\b/iu,
  /\be[-\s]?mail\b/iu,
  /\bbankverbindung\b/iu,
  /\bvorarl?berg\b/iu,
  /\brealisierung\b/iu,
  /\bstreitschlichtung\b/iu,
  /\bdatenschutz\b/iu,
  /\bbeauftragt\b/iu,
  /\bin\s+verbindung\b/iu
];

const STOP_BY_DIGITS = /\d/; // Adressen etc. raus

// Sehr konservatives "Name"-Pattern:
// - Entweder "Herr/Frau X" (auch 1 Nachname) oder
// - "Vorname Nachname" (mind. 2 Wörter), jeweils mit Großbuchstaben-Anfang
const PERSON_WITH_TITLE_RE =
  /^(Herr|Frau|Herrn|Dr.|Herr Dr.|Frau Dr.)\s+[A-ZÄÖÜ][\p{L}'’\-]+(?:\s+[A-ZÄÖÜ][\p{L}'’\-]+){0,3}$/u;

const PERSON_NO_TITLE_RE =
  /^[A-ZÄÖÜ][\p{L}'’\-]+(?:\s+[A-ZÄÖÜ][\p{L}'’\-]+){1,3}$/u;

const PERSON_SINGLE_TOKEN_RE =
  /^[A-ZÄÖÜ][\p{L}'’\-]{2,}$/u;

// Namen aus "Daniel Marquardt (Geschäftsführer)" extrahieren
const NAME_BEFORE_ROLE_PARENS_RE =
  /([A-ZÄÖÜ][\p{L}'’\-]+(?:\s+[A-ZÄÖÜ][\p{L}'’\-]+)+)\s*\((?:Geschäftsführer|GF|Inhaber|Betreiber|geschäftsführend[^)]*)\)/giu;

type CueBlockConfig = {
  label: string;
  regex: RegExp;
  supportsTwoLineDisambiguation: boolean;
};

const STREET_WITH_HOUSE_NUMBER_RE =
  /^[^\n,]{2,}\b\d{1,4}[a-zA-Z]?\b(?:\s*[-/]\s*\d{1,4}[a-zA-Z]?)?$/;

const POSTAL_CITY_RE = /^(?:D\s*[- ]\s*)?\d{5}\s+\S.+$/u;

// Cue-Blöcke (deine Varianten inkl. Tippfehler "Vetreten")
const CUE_BLOCK_REGEXES: CueBlockConfig[] = [
  // Vertreten durch (auch "Vetreten")
  {
    label: 'Vertreten durch',
    regex: /(?:\bve(?:r)?treten\s+durch\b)(?:\s+den\s+[^:\n]{0,80})?\s*:?\s*([\s\S]{1,500}?)(?=\n\s*\n|\n\s*(?:Vertreten\s+durch|Verantwortlich|Inhaltlich\s+verantwortlich)\b|$)/gi,
    supportsTwoLineDisambiguation: true,
  },

  // Verantwortlich für den Inhalt nach § 55 ...
  {
    label: 'Verantwortlich im Sinne von §55 RStV',
    regex: /\bverantwortlich\s+im\s+sinne\s+von\s+§?\s*55\s*rstv\b\s*:?\s*([\s\S]{1,250}?)(?=\n\s*\n|$)/gi,
    supportsTwoLineDisambiguation: true,
  },
  {
    label: 'Verantwortlich für den Inhalt',
    regex: /\bverantwortlich\s+für\s+den\s+inhalt\b(?:[^:\n]*:)?\s*([\s\S]{1,250}?)(?=\n\s*\n|$)/gi,
    supportsTwoLineDisambiguation: true,
  },

  // Verantwortlicher im Sinne von § 5 TMG
  {
    label: 'Verantwortlich im Sinne von §5 TMG',
    regex: /\bverantwortlich\w*\s+im\s+sinne\s+von\s+§?\s*5\s*tmg\b\s*:?\s*([\s\S]{1,250}?)(?=\n\s*\n|$)/gi,
    supportsTwoLineDisambiguation: true,
  },
  {
    label: 'Verantwortlich gemäß §5 TMG',
    regex: /\bverantwortlich\s+gemäß\s+§\s*5\s*tmg\b\s*:?\s*([\s\S]{1,250}?)(?=\n\s*\n|$)/gi,
    supportsTwoLineDisambiguation: true,
  },
  
  // Angaben gemäß § 5 TMG (mit unsichtbaren Zeichen und mehreren Umbrüchen)
  {
    label: 'Angaben gemäß §5 TMG',
    regex: /\bangaben\s+gemäß\s+§\s*5\s*tmg\b\s*:?[\s\u200B-\u200D\uFEFF]*([\s\S]{1,250}?)(?=\n\s*\n|$)/gi,
    supportsTwoLineDisambiguation: true,
  },

  // Inhaltlich verantwortlicher gemäß ...
  {
    label: 'Inhaltlich verantwortlich',
    regex: /\binhaltlich\s+verantwortlich\w*\b(?:[^:\n]*:)?\s*([\s\S]{1,250}?)(?=\n\s*\n|$)/gi,
    supportsTwoLineDisambiguation: true,
  },

  // Geschäftsführer / Inhaber (explizite Label)
  {
    label: 'Geschäftsführer/Inhaber/Betreiber',
    regex: /(?:\bGeschäftsführ(?:er|ung|erin|erinnen)\b|\bInhaber(?:in|inn?en)?\b|\bBetreiber(?:in|innen)?\b)\s*:?\s*([\s\S]{1,250}?)(?=\n\s*\n|\n\s*[A-Z][^:]{0,30}:|\n\s*\d|$)/gi,
    supportsTwoLineDisambiguation: false,
  },

  // Ansprechpartner / Kontaktperson
  {
    label: 'Ansprechpartner/Kontaktperson',
    regex: /(?:\bansprechpartner(?:in|innen)?\b|\bkontaktperson(?:en)?\b)\s*:?\s*([\s\S]{1,250}?)(?=\n\s*\n|\n\s*[A-Z][^:]{0,30}:|\n\s*\d|$)/gi,
    supportsTwoLineDisambiguation: false,
  },
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

function containsNonNameToken(s: string): boolean {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .some(t => NON_NAME_TOKENS.has(t));
}

function containsBlockedNamePattern(s: string): boolean {
  return BLOCKED_NAME_PATTERNS.some(re => re.test(s));
}

function transliterateGermanChars(s: string): string {
  return s
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

function normalizeForExactComparison(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function buildComparisonForms(s: string): string[] {
  const base = normalizeForExactComparison(s);
  if (!base) return [];

  const asciiGerman = normalizeForExactComparison(transliterateGermanChars(base));
  const noDiacritics = normalizeForExactComparison(
    base.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  );

  return Array.from(new Set([base, asciiGerman, noDiacritics].filter(Boolean)));
}

function containsBlockedExactName(
  s: string,
  blockedExactNames: Set<string>
): boolean {
  if (blockedExactNames.size === 0) return false;
  const forms = buildComparisonForms(s);
  if (forms.length === 0) return false;

  for (const form of forms) {
    if (blockedExactNames.has(form)) return true;
    for (const blocked of blockedExactNames) {
      const escaped = blocked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, "u");
      if (re.test(form)) return true;
    }
  }
  return false;
}

export function isLikelyPersonName(s: string, blockedExactNames: Set<string> = new Set()): boolean {
  if (!s) return false;
  if (STOP_BY_DIGITS.test(s)) return false;
  if (looksLikeBusinessLine(s)) return false;
  if (/[/@]|https?:\/\//i.test(s)) return false;
  if (containsNonNameToken(s)) return false;
  if (containsBlockedNamePattern(s)) return false;
  if (containsBlockedExactName(s, blockedExactNames)) return false;

  return PERSON_WITH_TITLE_RE.test(s) || PERSON_NO_TITLE_RE.test(s) || PERSON_SINGLE_TOKEN_RE.test(s);
}

function cleanCandidate(raw: string): string {
  // Klammer-Rollen raus: "(Geschäftsführer)" etc.
  let s = raw.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  // Führende/trailende Rollenlabels entfernen (z.B. "GF Markus", "Sandro Inhaber")
  s = s
    .replace(/^(?:gf|geschäftsführer(?:in)?|geschaeftsfuehrer(?:in)?|inhaber(?:in)?|geschäftsführung|geschaeftsfuehrung)\b[\s:;,\-–—]*/iu, "")
    .replace(/[\s:;,\-–—]+(?:gf|geschäftsführer(?:in)?|geschaeftsfuehrer(?:in)?|inhaber(?:in)?|geschäftsführung|geschaeftsfuehrung)\b\.?$/iu, "")
    .trim();
  // Satzzeichen am Rand weg
  s = s.replace(/^[\s:,\-–—]+/, "").replace(/[\s,.;:]+$/, "").trim();
  // Einzelne Initialen als Namensbestandteil verwerfen (z.B. "M Mustermann" -> "Mustermann")
  const parts = s.split(/\s+/).filter(Boolean);
  const withoutSingleLetterParts = parts.filter(p => !/^[A-Za-zÄÖÜäöü]$/u.test(p.replace(/[.'’\-]/g, "")));
  s = withoutSingleLetterParts.join(" ").trim();
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

  // Trennzeichen: Komma / Semikolon / " und " / & / Zeilenumbrüche
  return cutAtAddress
    .split(/\s*(?:,|;|\bund\b|&|\n)\s*/i)
    .map(x => x.trim())
    .filter(Boolean);
}

function getNonEmptyLines(block: string): string[] {
  return block
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function findAddressStartIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (!STREET_WITH_HOUSE_NUMBER_RE.test(lines[i])) continue;
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
      if (POSTAL_CITY_RE.test(lines[j])) {
        return i;
      }
    }
  }
  return -1;
}

function getTwoLineDisambiguationCandidates(block: string): [string, string] | null {
  const lines = getNonEmptyLines(block);
  if (lines.length < 4) return null;

  const addressStart = findAddressStartIndex(lines);
  // Sonderfall nur bei genau zwei Zeilen vor der erkannten Adresse
  if (addressStart !== 2) return null;

  const line1 = cleanCandidate(lines[0]);
  const line2 = cleanCandidate(lines[1]);
  if (!line1 || !line2) return null;

  return [line1, line2];
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

export function extractNamesDetailed(text: string, opts: ExtractOptions = {}): ExtractNamesDetailedResult {
  const t = normalizeText(text);
  let names: string[] = [];
  const pendingDisambiguations: PendingNameDisambiguation[] = [];
  const blockedExactNames = new Set<string>();
  if (opts.placeCity) {
    for (const cityForm of buildComparisonForms(opts.placeCity)) {
      blockedExactNames.add(cityForm);
    }
  }

  // 1) High-precision: Namen vor Rollen-Klammern überall einsammeln
  for (const m of t.matchAll(NAME_BEFORE_ROLE_PARENS_RE)) {
    const cand = cleanCandidate(m[1] ?? "");
    if (isLikelyPersonName(cand, blockedExactNames)) names.push(cand);
  }

  // 2) Cue-Blöcke: "Vertreten durch:", "§55", "§5 TMG", etc.
  for (const cue of CUE_BLOCK_REGEXES) {
    for (const m of t.matchAll(cue.regex)) {
      const block = (m[1] ?? "").trim();
      if (!block) continue;

      // Some impressum pages (e.g. Jimdo) render each address line as its own
      // paragraph separated by blank lines. The cue-block regex stops at the
      // first blank line, so it only captures the first paragraph ("Birdland
      // Kronau") and misses the person name on the next line ("Hans Jürgen Ries").
      // When we have fewer than 3 non-empty lines, extend the scan window by
      // reading ahead in the normalized text so that getTwoLineDisambiguationCandidates
      // and splitCandidates see the full address block.
      let scanBlock = block;
      if (cue.supportsTwoLineDisambiguation && getNonEmptyLines(block).length < 3 && m.index !== undefined) {
        const matchEnd = m.index + m[0].length;
        const ahead = t.slice(matchEnd, matchEnd + 300);
        // A single leading blank line (formatting gap between cue label and data)
        // is acceptable. Once the first content line appears, stop at the next
        // blank line – anything after it belongs to a different section.
        const firstNonBlank = ahead.search(/[^\s]/);
        if (firstNonBlank >= 0) {
          const contentAhead = ahead.slice(firstNonBlank);
          const blankIdx = contentAhead.search(/\n\s*\n/);
          const firstParagraph = blankIdx >= 0 ? contentAhead.slice(0, blankIdx) : contentAhead;
          const aheadLines = firstParagraph.split('\n').map(l => l.trim()).filter(Boolean);
          if (aheadLines.length > 0) {
            scanBlock = [block, ...aheadLines].join('\n');
          }
        }
      }

      if (cue.supportsTwoLineDisambiguation) {
        const pair = getTwoLineDisambiguationCandidates(scanBlock);
        if (pair) {
          const valid = pair.filter(candidate => isLikelyPersonName(candidate, blockedExactNames));
          if (valid.length === 2) {
            pendingDisambiguations.push({
              line1: valid[0],
              line2: valid[1],
              cueLabel: cue.label,
            });
            names.push(valid[0], valid[1]);
          } else if (valid.length === 1) {
            names.push(valid[0]);
          }
        } else {
          // Fallback: no address block detected but exactly two person-name candidates
          // (e.g. business name + person name on consecutive blank-separated paragraphs
          // as seen on Jimdo sites). Delegate to the LLM rather than returning both.
          const candidates = uniquePreserve(
            splitCandidates(scanBlock).map(cleanCandidate).filter(candidate => isLikelyPersonName(candidate, blockedExactNames))
          );
          if (candidates.length === 2) {
            pendingDisambiguations.push({
              line1: candidates[0],
              line2: candidates[1],
              cueLabel: cue.label,
            });
            names.push(candidates[0], candidates[1]);
          } else {
            for (const cand of candidates) names.push(cand);
          }
        }
      }

      for (const part of splitCandidates(scanBlock)) {
        const cand = cleanCandidate(part);
        if (isLikelyPersonName(cand, blockedExactNames)) names.push(cand);
      }
    }
  }

  // 3) Optional: sehr vorsichtiger Zeilen-Scan (für Fälle wie "Restaurant XYZ\nHerr Eppel")
  if (opts.enableLooseLineScan) {
    const lines = t.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const cand = cleanCandidate(line);
      if (isLikelyPersonName(cand, blockedExactNames)) names.push(cand);
    }
  }

  names = uniquePreserve(names);

  return { names, pendingDisambiguations };
}

export function extractNames(text: string, opts: ExtractOptions = {}): string[] {
  const result = extractNamesDetailed(text, opts);
  if (opts.takeFirst && result.names.length > 0) return [result.names[0]];
  return result.names;
}
