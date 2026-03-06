import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { extractNames } from './extractNames';
import { logger } from './logger';
import { normalizeOwnerNamesFromCandidates } from './owner-name-normalizer';

interface ScraperOptions {
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export interface LightboxScrapeResult {
  owner: string | null;
  ownerSalutations: string | null;
  ownerFirstNames: string | null;
  ownerLastNames: string | null;
  email: string | null;
  lightboxFound: boolean;
  lightboxText: string | null;
  targetSelector: string | null;
}

const FIRST_NAME_LABELS = new Set(['first name', 'vorname']);
const LAST_NAME_LABELS = new Set(['last name', 'nachname']);
const EMAIL_LABELS = new Set(['e-mail-adresse', 'e-mail', 'email', 'emailadresse', 'mail']);
const OWNER_LABELS = new Set([
  'verantwortlicher',
  'verantwortlich',
  'owner',
  'geschaftsfuhrer',
  'geschaeftsfuehrer',
  'geschaftsfuhrerin',
  'geschaeftsfuhrerin',
  'inhaber',
  'betreiber',
  'operator',
]);

function normalizeLabel(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[:：]+$/g, '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss');
}

function readNodeValue(node: cheerio.Cheerio<any>, fallbackLabel?: string): string {
  const direct = node.text().replace(/\s+/g, ' ').trim();
  if (direct && (!fallbackLabel || normalizeLabel(direct) !== fallbackLabel)) return direct;

  const inputValue = node.attr('value')?.trim();
  if (inputValue) return inputValue;

  return '';
}

function extractValueNearLabel($: cheerio.CheerioAPI, el: Element, normalizedLabel: string): string {
  const current = $(el);
  const candidates: cheerio.Cheerio<any>[] = [
    current.next(),
    current.nextAll().first(),
    current.parent().next(),
    current.parent().nextAll().first(),
    current.closest('label').next(),
    current.closest('label').nextAll().first(),
  ].filter((node) => node.length > 0);

  for (const candidate of candidates) {
    const value = readNodeValue(candidate, normalizedLabel);
    if (value) return value;
  }

  return '';
}

function pushUniqueValue(values: string[], rawValue: string): boolean {
  const value = rawValue.replace(/\s+/g, ' ').trim();
  if (!value) return false;
  const key = value.toLowerCase();
  if (values.some((entry) => entry.toLowerCase() === key)) return false;
  values.push(value);
  return true;
}

/**
 * Durchsucht eine URL nach einem Impressum/Imprint-Button, isoliert die
 * verknüpfte Lightbox im DOM und extrahiert Regex-basiert den Owner.
 */
export async function scrapeImprintLightbox(url: string, options?: ScraperOptions): Promise<LightboxScrapeResult> {
  const log = options?.log ?? ((msg: string) => logger.log(msg));
  const result: LightboxScrapeResult = {
    owner: null,
    ownerSalutations: null,
    ownerFirstNames: null,
    ownerLastNames: null,
    email: null,
    lightboxFound: false,
    lightboxText: null,
    targetSelector: null,
  };

  log(`[Scraper] Lightbox scrape gestartet für URL: ${url}`);
  
  try {
    const response = await fetch(url, {
      signal: options?.timeoutMs ? AbortSignal.timeout(options?.timeoutMs) : undefined,
    });

    if (!response.ok) {
      logger.error(`[Scraper] Lightbox fetch fehlgeschlagen. HTTP Status: ${response.status}`);
      return result;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const imprintButton = $('a').filter((_, el) => {
      const text = $(el).text().trim().toLowerCase();
      return text === 'imprint' || text === 'impressum';
    }).first();

    if (imprintButton.length === 0) {
      log(`[Scraper] Kein exakter Imprint/Impressum-Button gefunden.`);
      return result;
    }

    log(`[Scraper] Imprint-Button gefunden.`);

    const targetSelector = 
      imprintButton.attr('data-pointer') || 
      imprintButton.attr('data-page') || 
      imprintButton.attr('href');
    result.targetSelector = targetSelector || null;

    if (!targetSelector || !targetSelector.startsWith('#')) {
      log(`[Scraper] Ziel ist keine In-Page Lightbox oder fehlt: ${targetSelector ?? 'n/a'}`);
      return result;
    }

    const lightbox = $(targetSelector);

    if (lightbox.length === 0) {
      log(`[Scraper] Lightbox '${targetSelector}' nicht im DOM gefunden.`);
      return result;
    }

    result.lightboxFound = true;
    const lightboxText = lightbox.text().replace(/\s+/g, ' ').trim();
    result.lightboxText = lightboxText || null;

    log(`[Scraper] Lightbox '${targetSelector}' isoliert. Regex-Owner-Suche...`);

    const firstNames: string[] = [];
    const lastNames: string[] = [];
    const ownerCandidates: string[] = [];
    const emails: string[] = [];

    lightbox.find('*').each((_, el: Element) => {
      const labelText = normalizeLabel($(el).text());
      if (!labelText) return;

      if (FIRST_NAME_LABELS.has(labelText)) {
        const value = extractValueNearLabel($, el, labelText);
        if (pushUniqueValue(firstNames, value)) {
          log(`[Scraper] -> Vorname extrahiert: ${value}`);
        } else {
          log(`[Scraper] -> Vorname Label gefunden, aber leer/duplikat.`);
        }
      }

      if (LAST_NAME_LABELS.has(labelText)) {
        const value = extractValueNearLabel($, el, labelText);
        if (pushUniqueValue(lastNames, value)) {
          log(`[Scraper] -> Nachname extrahiert: ${value}`);
        } else {
          log(`[Scraper] -> Nachname Label gefunden, aber leer/duplikat.`);
        }
      }

      if (OWNER_LABELS.has(labelText)) {
        const value = extractValueNearLabel($, el, labelText);
        if (pushUniqueValue(ownerCandidates, value)) {
          log(`[Scraper] -> Verantwortlicher extrahiert: ${value}`);
        } else {
          log(`[Scraper] -> Verantwortlicher Label gefunden, aber leer/duplikat.`);
        }
      }

      if (EMAIL_LABELS.has(labelText)) {
        const value = extractValueNearLabel($, el, labelText);
        if (pushUniqueValue(emails, value)) {
          log(`[Scraper] -> E-Mail extrahiert: ${value}`);
        }
      }
    });

    if (emails.length > 0) {
      result.email = emails[0];
    } else if (lightboxText) {
      const emailMatch = lightboxText.match(/\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/);
      if (emailMatch) {
        result.email = emailMatch[0];
        log(`[Scraper] -> E-Mail via Regex extrahiert: ${result.email}`);
      }
    }

    if (firstNames.length > 0 || lastNames.length > 0) {
      const combinedNames: string[] = [];
      const maxLen = Math.max(firstNames.length, lastNames.length);

      for (let i = 0; i < maxLen; i++) {
        const combined = `${firstNames[i] ?? ''} ${lastNames[i] ?? ''}`.replace(/\s+/g, ' ').trim();
        if (combined) combinedNames.push(combined);
      }

      if (combinedNames.length > 0) {
        const normalized = normalizeOwnerNamesFromCandidates(combinedNames);
        result.owner = normalized.ownerDisplay;
        result.ownerSalutations = normalized.ownerSalutations;
        result.ownerFirstNames = normalized.ownerFirstNames;
        result.ownerLastNames = normalized.ownerLastNames;
        log(`[Scraper] Regex-Owner gefunden: ${result.owner}`);
        return result;
      }
    }

    if (ownerCandidates.length > 0) {
      const normalized = normalizeOwnerNamesFromCandidates(ownerCandidates);
      result.owner = normalized.ownerDisplay;
      result.ownerSalutations = normalized.ownerSalutations;
      result.ownerFirstNames = normalized.ownerFirstNames;
      result.ownerLastNames = normalized.ownerLastNames;
      log(`[Scraper] Regex-Owner gefunden: ${result.owner}`);
      return result;
    }

    if (lightboxText) {
      const names = extractNames(lightboxText, { takeFirst: false });
      if (names.length > 0) {
        const normalized = normalizeOwnerNamesFromCandidates(names);
        result.owner = normalized.ownerDisplay;
        result.ownerSalutations = normalized.ownerSalutations;
        result.ownerFirstNames = normalized.ownerFirstNames;
        result.ownerLastNames = normalized.ownerLastNames;
        log(`[Scraper] Regex-Owner aus Lightbox-Text gefunden: ${result.owner}`);
        return result;
      }
    }

    log(`[Scraper] Lightbox gefunden, aber kein Regex-Owner erkannt.`);
    return result;

  } catch (error) {
    logger.error(`[Scraper] Kritischer Fehler beim Lightbox-Scraping von ${url}:`, error);
    return result;
  }
}

export async function getOwnerNameFromImprint(url: string, options?: ScraperOptions): Promise<string | null> {
  const result = await scrapeImprintLightbox(url, options);
  return result.owner;
}