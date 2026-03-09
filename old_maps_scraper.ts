import { logger } from '@/lib/logger';
/**
 * maps-scraper.ts – Stateless Google Maps scraper.
 *
 * Receives an already-open Playwright Page from ScraperPool / ScraperWorker.
 * scrape() is an async generator so callers can break early.
 */
import { Page } from 'playwright';

// ─── Block Detection ──────────────────────────────────────────────────────────

/**
 * Level 1 – Hard Block:   CAPTCHA / 403 redirect (URL or reCAPTCHA iframe)
 * Level 2 – Soft Block:   Detail panel never opens after click (timeout ×2)
 * Level 3 – Ghost Block:  Panel opens but API data missing for 3 rows in a row
 */
export type BlockLevel = 1 | 2 | 3;

export class BlockDetectionError extends Error {
    level: BlockLevel;
    constructor(level: BlockLevel, message: string) {
        super(message);
        this.name = 'BlockDetectionError';
        this.level = level;
    }
}

export interface PlaceResult {
    name: string;
    website?: string;
    phone?: string;
    rating?: number;
    reviews?: number;
    hours?: string;
    address?: string;
    placeKey?: string;   // dedup key extracted from Maps URL
    price?: string;
    exactIndustry?: string;
}

export class GoogleMapsScraper {
    private page: Page;
    private minPrice?: number;
    private maxPrice?: number;

    constructor(page: Page, minPrice?: number, maxPrice?: number) {
        this.page = page;
        this.minPrice = minPrice;
        this.maxPrice = maxPrice;
    }

    private parsePrice(priceString: string): { lowerBound: number, upperBound: number } | null {
        if (!priceString) return null;
        
        // Match "20-30€" or "€20-€30" or "€ 20-30" etc
        const rangeMatch = priceString.match(/(\d+)[^\d]+(\d+)/);
        if (rangeMatch) {
            return {
                lowerBound: parseInt(rangeMatch[1], 10),
                upperBound: parseInt(rangeMatch[2], 10)
            };
        }

        // Match "Mehr als 100€" or "More than 100€" etc
        const moreThanMatch = priceString.match(/(mehr als|more than|>|>|ab)\s*.*?(\d+)/i);
        if (moreThanMatch) {
            return {
                lowerBound: parseInt(moreThanMatch[2], 10),
                upperBound: Infinity
            };
        }

        // Match "X €" or "€ X" or standard single numbers
        const singleNumberMatch = priceString.match(/(\d+)/);
        if (singleNumberMatch) {
            const val = parseInt(singleNumberMatch[1], 10);
            return { lowerBound: val, upperBound: val };
        }

        // Euro symbols (€, €€, €€€)
        const euroCount = (priceString.match(/€/g) || []).length;
        if (euroCount > 0) {
            if (euroCount === 1) return { lowerBound: 0, upperBound: 10 };
            if (euroCount === 2) return { lowerBound: 10, upperBound: 25 };
            if (euroCount === 3) return { lowerBound: 25, upperBound: 50 };
            if (euroCount >= 4) return { lowerBound: 50, upperBound: Infinity };
        }

        return null;
    }

    private matchesPrice(priceString?: string): boolean {
        // If no price specified, keep it
        if (!priceString) return true;
        
        const bounds = this.parsePrice(priceString);
        if (!bounds) return true;

        if (this.minPrice !== undefined && bounds.upperBound < this.minPrice) return false;
        if (this.maxPrice !== undefined && bounds.lowerBound > this.maxPrice) return false;

        return true;
    }

    // ── Block detection helpers ────────────────────────────────────────────

    /**
     * Level 1 – Hard Block: checks current URL and DOM for CAPTCHA signals.
     * Throws BlockDetectionError(1) if detected.
     */
    private async checkForHardBlock(): Promise<void> {
        const url = this.page.url();
        if (url.includes('/sorry/index') || url.includes('google.com/sorry')) {
            throw new BlockDetectionError(1, `Hard block (CAPTCHA redirect): ${url}`);
        }
        const hasCaptcha = await this.page.$('iframe[src*="recaptcha"]')
            .then(el => !!el)
            .catch(() => false);
        if (hasCaptcha) {
            throw new BlockDetectionError(1, 'Hard block: reCAPTCHA iframe detected on page');
        }
    }

    // Shorter, more realistic delays
    private async randomDelay(min: number = 200, max: number = 600) {
        const delay = Math.floor(Math.random() * (max - min + 1) + min);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Human-like mouse movement: curves toward element via a random intermediate point
    private async humanMove(element: import('playwright').ElementHandle) {
        try {
            const box = await element.boundingBox();
            if (!box) return;

            // Randomised target within element bounds (avoid dead-center)
            const targetX = box.x + box.width  * (0.25 + Math.random() * 0.5);
            const targetY = box.y + box.height * (0.25 + Math.random() * 0.5);

            // Intermediate point: slightly off-course, simulates natural cursor arc
            const midX = targetX + (Math.random() - 0.5) * 100;
            const midY = targetY + (Math.random() - 0.5) * 70;

            await this.page.mouse.move(midX, midY, { steps: 8 });
            await new Promise(r => setTimeout(r, 25 + Math.random() * 55));
            await this.page.mouse.move(targetX, targetY, { steps: 5 });
        } catch { /* element may have been detached */ }
    }

    // Scroll feed in small irregular steps instead of jumping to the bottom at once
    private async smoothScroll(feedSelector: string) {
        const steps = 3 + Math.floor(Math.random() * 3); // 3–5 steps
        for (let i = 0; i < steps; i++) {
            await this.page.evaluate((sel) => {
                const feed = document.querySelector(sel);
                if (feed) {
                    // Each step scrolls a random small amount
                    feed.scrollTop += 180 + Math.random() * 220;
                }
            }, feedSelector);
            await this.randomDelay(100, 300);
        }
    }

    // Human-like typing with variable speed
    private async humanType(text: string) {
        for (const char of text) {
            await this.page.keyboard.type(char);
            // Variable typing speed: 30-120ms per character
            await new Promise(resolve => setTimeout(resolve, 30 + Math.random() * 90));
        }
    }

    async search(city: string, industry: string) {
        const query = `${industry} in ${city}`;

        // Navigate with domcontentloaded (don't wait for images/fonts)
        await this.page.goto('https://www.google.com/maps', {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });

        await this.randomDelay(400, 800);

        // Handle consent dialog efficiently
        try {
            const consentRegex = /(accept all|agree|reject all|alle akzeptieren|alle ablehnen|zustimmen)/i;
            const consentButton = this.page.locator('button').filter({ hasText: consentRegex }).first();
            
            if (await consentButton.isVisible({ timeout: 5000 })) {
                await consentButton.scrollIntoViewIfNeeded();
                await this.randomDelay(100, 300);
                await consentButton.click({ delay: 100 });
                await this.randomDelay(300, 600);
            } else {
                // Fallback via evaluate in case of complex shadow DOMs
                const consentHandled = await this.page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const target = buttons.find(b => {
                        const text = (b.textContent || '').toLowerCase();
                        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                        return text.includes('accept') || text.includes('agree') || 
                               aria.includes('accept') || aria.includes('agree') ||
                               text.includes('reject all') || text.includes('akzeptieren') ||
                               text.includes('ablehnen') || text.includes('zustimmen');
                    });

                    if (target) {
                        target.scrollIntoView({ block: 'center' });
                        (target as HTMLElement).click();
                        return true;
                    }
                    return false;
                });

                if (consentHandled) {
                    await this.randomDelay(300, 600);
                }
            }
        } catch (e) {
            // Consent already handled or not present
        }

        // Wait for search box to appear (might take a moment if consent redirect happens)
        try {
            await this.page.waitForSelector('#searchboxinput, input[name="q"]', { state: 'visible', timeout: 15000 });
        } catch {
            // we will just try our manual strategies next
        }

        // Find search box with multiple strategies
        let searchFilled = false;

        // Strategy 1: ID selector
        try {
            const box = await this.page.$('#searchboxinput');
            if (box) {
                await this.humanMove(box);
                await box.click();
                await this.randomDelay(100, 250);
                await this.humanType(query);
                searchFilled = true;
            }
        } catch { }

        // Strategy 2: name attribute
        if (!searchFilled) {
            try {
                const box = await this.page.$('input[name="q"]');
                if (box) {
                    await this.humanMove(box);
                    await box.click();
                    await this.randomDelay(100, 250);
                    await this.humanType(query);
                    searchFilled = true;
                }
            } catch { }
        }

        // Strategy 3: First input field
        if (!searchFilled) {
            try {
                const box = await this.page.$('input[type="text"]');
                if (box) {
                    await this.humanMove(box);
                    await box.click();
                    await this.randomDelay(100, 250);
                    await this.humanType(query);
                    searchFilled = true;
                }
            } catch { }
        }

        if (!searchFilled) {
            throw new Error('Could not locate search box');
        }

        await this.randomDelay(200, 500);
        await this.page.keyboard.press('Enter');

        // Wait for results - use networkidle for better timing
        try {
            await Promise.race([
                this.page.waitForSelector('div[role="feed"]', { state: 'visible', timeout: 6000 }),
                this.page.waitForLoadState('networkidle', { timeout: 6000 })
            ]);
        } catch (e) {
            // Results may still be loading
        }

        await this.randomDelay(800, 1500);
    }

    /**
     * Async generator – yields one PlaceResult per listing.
     * Throws BlockDetectionError when a Google block signal is detected.
     * Caller can break early (abort signal / max results).
     */
    async *scrape(signal?: AbortSignal): AsyncGenerator<PlaceResult> {
        const feedSel = 'div[role="feed"]';
        const seen    = new Set<string>();
        let noNew = 0;

        // Block detection counters
        let consecutiveTimeouts = 0; // Level 2 – Soft block
        let consecutiveEmpty    = 0; // Level 3 – Ghost block

        while (true) {
            if (signal?.aborted) break;

            // ── Level 1: Hard block check at start of every scan loop ─────────
            await this.checkForHardBlock();

            const cards = await this.page.$$('div[role="article"]');
            let processedOne = false;

            try {
                for (const card of cards) {
                    if (signal?.aborted) return;
                try {
                    const label = await card.getAttribute('aria-label');
                    if (!label || seen.has(label)) continue;

                    await card.scrollIntoViewIfNeeded();
                    await this.randomDelay(150, 400);
                    await this.humanMove(card);
                    await card.click();
                    await this.randomDelay(400, 900);

                    // ── Level 2: Soft block – detail panel must show <h1> within 5 s ──
                    try {
                        await this.page.waitForSelector('h1', { state: 'visible', timeout: 5000 });
                        consecutiveTimeouts = 0; // panel loaded → reset counter
                    } catch {
                        consecutiveTimeouts++;
                        logger.warn(`[Maps] Panel timeout #${consecutiveTimeouts} for "${label}"`);
                        if (consecutiveTimeouts >= 2) {
                            throw new BlockDetectionError(2,
                                `Soft block: detail panel failed to load ${consecutiveTimeouts}× in a row`);
                        }
                        continue; // skip this card, try next
                    }

                    // ── Level 1: Re-check after click (URL may have changed) ──────────
                    await this.checkForHardBlock();

                    const details = await this.extractDetails(label);
                    if (details) {
                        // ── Level 3: Ghost block – count fully empty results ──────────
                        const isEmpty = !details.phone && !details.website &&
                                        !details.hours && !details.rating;
                        if (isEmpty) {
                            consecutiveEmpty++;
                            logger.warn(`[Maps] Empty result #${consecutiveEmpty} for "${label}"`);
                            if (consecutiveEmpty >= 3) {
                                throw new BlockDetectionError(3,
                                    `Ghost block: ${consecutiveEmpty} consecutive results with no data`);
                            }
                        } else {
                            consecutiveEmpty = 0;
                        }

                        seen.add(label);
                        noNew = 0;
                        
                        if (this.matchesPrice(details.price)) {
                            yield details;
                        } else {
                            logger.log(`[Maps] Skipped "${label}" due to price filter (Found: ${details.price})`);
                        }
                    }

                    // Ensure list panel is still visible
                    const listVisible = await this.page.isVisible(feedSel).catch(() => false);
                    if (!listVisible) {
                        const back = await this.page.$('button[aria-label*="Back"]');
                        if (back) { await back.click(); await this.randomDelay(300, 600); }
                    }

                    processedOne = true;
                    break; // Re-scan DOM after each place
                } catch (e) {
                    if (e instanceof BlockDetectionError) throw e; // propagate immediately
                    logger.error('[Maps] Error processing card:', e);
                }
            }
            } finally {
                // Free the handles so Playwright V8 engine does not accumulate them
                for (const card of cards) {
                    await card.dispose().catch(() => null);
                }
            }

            if (!processedOne) {
                noNew++;
                try {
                    const end = await this.page.$('span.HlvSq');
                    if (end && (await end.textContent())?.includes('end of the list')) {
                        logger.log('[Maps] Reached end of list');
                        break;
                    }
                } catch {}

                if (noNew > 4) { logger.log('[Maps] No new results, stopping'); break; }

                try { await this.page.hover(feedSel); } catch {}
                await this.smoothScroll(feedSel);
                await this.randomDelay(700, 1400);
            }
        }
        logger.log(`[Maps] Done – ${seen.size} places found`);
    }

    private async extractDetails(name: string): Promise<PlaceResult | null> {
        try {
            const result: PlaceResult = { name };

            // Extract a stable key from the page URL (contains CID / place ID)
            try {
                const url = this.page.url();
                const m   = url.match(/place\/[^/]+\/([@\w!,+.-]+)/);
                result.placeKey = m ? m[1] : undefined;
            } catch {}

            // Website
            try {
                const link = await this.page.$('a[data-item-id="authority"]');
                if (link) {
                    const href = await link.getAttribute('href');
                    if (href) {
                        try {
                            const urlObj = new URL(href);
                            const { domainToUnicode } = require('node:url');
                            urlObj.hostname = domainToUnicode(urlObj.hostname);
                            result.website = urlObj.toString();
                        } catch {
                            result.website = href;
                        }
                    }
                }
            } catch { }

            // Phone
            try {
                const phoneBtn = await this.page.$('button[data-item-id^="phone"]');
                if (phoneBtn) {
                    const label = await phoneBtn.getAttribute('aria-label');
                    if (label) {
                        // Google Maps often surrounds text with invisible bidirectional characters (e.g. \u202A).
                        // That prevents the ^ anchor in Regex from cleanly matching the start of the string.
                        let cleanLabel = label.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, '');
                        result.phone = cleanLabel.replace(/^(Phone|Telefon):\s*/i, '').trim();
                    }
                }
            } catch { }

            // Rating & Reviews
            try {
                const ratingText = await this.page.$eval(
                    '.F7nice span[aria-hidden="true"]',
                    el => el.textContent
                ).catch(() => null);

                if (ratingText) {
                    result.rating = parseFloat(ratingText.replace(',', '.'));
                }

                const reviewLabel = await this.page.$eval(
                    '.F7nice span[aria-label*="reviews" i], .F7nice span[aria-label*="Rezensionen" i]',
                    el => el.getAttribute('aria-label')
                ).catch(() => null);

                if (reviewLabel) {
                    const match = reviewLabel.match(/(\d[\d,.]*)/);
                    if (match) {
                        result.reviews = parseInt(match[0].replace(/[,.]/g, ''));
                    }
                }
            } catch { }

            // Price Extractions
            try {
                const spans = await this.page.$$eval('span', els => els.map(e => e.textContent || ''));
                for (const text of spans) {
                    let cleanText = text.replace(/\s+/g, ' ').replace(/\u00A0/g, ' ').trim();
                    // Clean up leading dots or whitespace (e.g. "· €€")
                    cleanText = cleanText.replace(/^[·•\-\s]+/, '').trim();
                    if (cleanText.includes('€')) {
                        // If it's a relatively short text snippet containing at least one digit or multiple € signs
                        if (cleanText.length < 40 && (/\d/.test(cleanText) || /€{2,}/.test(cleanText))) {
                            result.price = cleanText;
                            logger.log(`[Maps] Extracted price: "${result.price}"`);
                            break;
                        }
                    }
                }
            } catch (e) {
                logger.error('[Maps] Error extracting price:', e);
            }

            // Exact Industry
            try {
                const categoryBtn = await this.page.$('button[jsaction*="category"]');
                if (categoryBtn) {
                    const text = await categoryBtn.textContent();
                    if (text) {
                        result.exactIndustry = text.trim();
                    }
                }
            } catch { }

            // Hours
            try {
                // Try to expand hours first, handle both English and German labels
                const expandBtn = await this.page.$('button[aria-label*="open hours" i], span[aria-label*="open hours" i], span[aria-label*="Show open hours" i], div[aria-label*="hours" i], button[aria-label*="Öffnungszeiten" i], span[aria-label*="Öffnungszeiten" i], div[aria-label*="Öffnungszeiten" i], button[data-item-id="openhours"]');
                if (expandBtn) {
                    await expandBtn.click();
                    await this.randomDelay(400, 800);

                    // Parse hours table - making selectors more robust in case class names changed
                    const rows = await this.page.$$('table tr');
                    if (rows.length > 0) {
                        const hoursList: string[] = [];
                        for (const row of rows) {
                            try {
                                const tds = await row.$$('td');
                                if (tds.length >= 2) {
                                    const day = await tds[0].textContent();
                                    const time = (await tds[1].getAttribute('aria-label')) || (await tds[1].textContent());
                                    
                                    if (day && time && day.trim() && time.trim()) {
                                        hoursList.push(`${day.trim()}: ${time.trim()}`);
                                    }
                                }
                            } catch { }
                        }
                        if (hoursList.length > 0) {
                            result.hours = hoursList.join(' | ');
                            logger.log(`[Maps] Extracted hours (table): ${result.hours}`);
                        }
                    }
                    
                    if (!result.hours) {
                        // generic table fallback
                        const hoursTable = await this.page.$('table');
                        if (hoursTable) {
                            const hoursText = await hoursTable.innerText();
                            if (hoursText && hoursText.length > 10) {
                                result.hours = hoursText.replace(/\n/g, ', ');
                                logger.log(`[Maps] Extracted hours (presentation table): ${result.hours}`);
                            }
                        }
                    }
                }

                // Fallback to button/element label
                if (!result.hours) {
                    const hoursBtn = await this.page.$('button[data-item-id="openhours"], div[data-item-id="openhours"], button[aria-label*="Öffnungszeiten" i], button[aria-label*="hours" i]');
                    if (hoursBtn) {
                        const rawHours = (await hoursBtn.getAttribute('aria-label')) || (await hoursBtn.innerText());
                        if (rawHours) {
                            result.hours = rawHours.replace(/\n/g, ' ').trim();
                            logger.log(`[Maps] Extracted hours (button fallback): ${result.hours}`);
                        }
                    }
                }
                
                if (!result.hours) {
                    logger.log(`[Maps] Could not extract hours for ${name}`);
                }
            } catch (e) {
                logger.error('[Maps] Error extracting hours:', e);
            }

            // Address
            try {
                const addressBtn = await this.page.$('button[data-item-id="address"]');
                if (addressBtn) {
                    const label = await addressBtn.getAttribute('aria-label');
                    if (label) {
                        // Strip invisible characters to ensure clean replacement and db storage
                        let cleanLabel = label.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, '');
                        result.address = cleanLabel.replace(/^(Address|Adresse):\s*/i, '').trim();
                    }
                }
            } catch { }

            return result;

        } catch (e) {
            logger.error('Error extracting details:', e);
            return null;
        }
    }

}