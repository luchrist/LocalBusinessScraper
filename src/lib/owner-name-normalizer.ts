export const OWNER_LIST_SEPARATOR = ' & ';

export interface ParsedOwnerName {
  fullName: string;
  salutation: string | null;
  firstName: string;
  lastName: string;
}

export interface OwnerNameNormalization {
  ownerDisplay: string | null;
  ownerSalutations: string | null;
  ownerFirstNames: string | null;
  ownerLastNames: string | null;
  owners: ParsedOwnerName[];
}

function uniquePreserve(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

function splitOwnerCandidates(ownerText: string): string[] {
  return ownerText
    .split(/\s*(?:\||;|,|\n|\bund\b|&|\/+)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitNameByRule(fullName: string): ParsedOwnerName {
  let salutation: string | null = null;
  let remainingName = fullName.replace(/\s+/g, ' ').trim();

  const lowerName = remainingName.toLowerCase();
  if (lowerName.startsWith('herr ')) {
    salutation = 'Herr';
    remainingName = remainingName.substring(5).trim();
  } else if (lowerName.startsWith('frau ')) {
    salutation = 'Frau';
    remainingName = remainingName.substring(5).trim();
  }

  const parts = remainingName.split(' ').filter(Boolean);

  if (parts.length <= 1) {
    return {
      fullName,
      salutation,
      firstName: '',
      lastName: parts[0] ?? '',
    };
  }

  if (parts.length === 2) {
    return {
      fullName,
      salutation,
      firstName: parts[0],
      lastName: parts[1],
    };
  }

  if (parts.length === 3) {
    return {
      fullName,
      salutation,
      firstName: `${parts[0]} ${parts[1]}`,
      lastName: parts[2],
    };
  }

  if (parts.length === 4) {
    return {
      fullName,
      salutation,
      firstName: `${parts[0]} ${parts[1]}`,
      lastName: `${parts[2]} ${parts[3]}`,
    };
  }

  const splitIndex = Math.ceil(parts.length / 2);
  return {
    fullName,
    salutation,
    firstName: parts.slice(0, splitIndex).join(' '),
    lastName: parts.slice(splitIndex).join(' '),
  };
}

function joinList(values: string[]): string | null {
  if (values.length === 0) return null;
  if (!values.some((value) => value.trim().length > 0)) return null;
  return values.join(OWNER_LIST_SEPARATOR);
}

export function normalizeOwnerNamesFromCandidates(candidates: string[]): OwnerNameNormalization {
  const uniqueCandidates = uniquePreserve(candidates);
  const rawOwners = uniqueCandidates.map(splitNameByRule);

  // Deduplicate by combination of first name and last name
  const owners: ParsedOwnerName[] = [];
  const seenNameCombos = new Set<string>();

  for (const owner of rawOwners) {
    const fn = owner.firstName.trim().toLowerCase();
    const ln = owner.lastName.trim().toLowerCase();
    // Only last name given or both given should be checked. 
    // If somehow both are empty, combo is empty space.
    const combo = `${fn} ${ln}`;
    
    if (seenNameCombos.has(combo)) {
      continue;
    }
    seenNameCombos.add(combo);
    owners.push(owner);
  }

  const finalDisplays = owners.map((o) => o.fullName);

  return {
    ownerDisplay: finalDisplays.length > 0 ? finalDisplays.join(', ') : null,
    ownerSalutations: joinList(
      owners
        .map((owner) => owner.salutation)
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
    ),
    ownerFirstNames: joinList(owners.map((owner) => owner.firstName)),
    ownerLastNames: joinList(owners.map((owner) => owner.lastName)),
    owners,
  };
}

export function normalizeOwnerNameString(ownerText: string | null | undefined): OwnerNameNormalization {
  const raw = ownerText?.trim();
  if (!raw) {
    return {
      ownerDisplay: null,
      ownerSalutations: null,
      ownerFirstNames: null,
      ownerLastNames: null,
      owners: [],
    };
  }

  return normalizeOwnerNamesFromCandidates(splitOwnerCandidates(raw));
}
