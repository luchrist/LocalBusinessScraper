import { chromium, Browser, Page, BrowserContext } from 'playwright';

export interface PlaceResult {
    name: string;
    website?: string;
    phone?: string;
    rating?: number;
    reviews?: number;
    hours?: string;
    address?: string;
}

export class GoogleMapsScraper {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;

    async launch() {
        this.browser = await chromium.launch({
            headless: false, // Often needed for Google Maps to work properly/avoid immediate blocking, or debugging
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-infobars',
                '--window-position=0,0',
                '--ignore-certifcate-errors',
                '--ignore-certifcate-errors-spki-list',
                '--disable-blink-features=AutomationControlled', // Key for stealth
            ],
        });

        this.context = await this.browser.newContext({
            viewport: { width: 1366, height: 768 },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });

        this.page = await this.context.newPage();

        // Stealth scripts
        await this.page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
        });
    }

    private async randomDelay(min: number = 500, max: number = 2000) {
        const delay = Math.floor(Math.random() * (max - min + 1) + min);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    async search(city: string, industry: string) {
        if (!this.page) throw new Error('Browser not initialized');

        const query = `${industry} in ${city}`;

        // Go to Google Maps
        try {
            await this.page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            console.log('Navigation timeout, checking if page loaded anyway...');
        }

        // Robust Consent Handling
        try {
            const consentButton = await this.page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const target = buttons.find(b => {
                    const label = (b.textContent || b.getAttribute('aria-label') || '').toLowerCase();
                    return (
                        label.includes('accept all') ||
                        label.includes('agree') ||
                        label === 'accept'
                    );
                });
                return target;
            });

            if (await consentButton.asElement()) {
                //@ts-expect-error
                await consentButton.click();
                await this.randomDelay(1000, 2000);
            }
        } catch (e) {
            console.log('Error handling consent:', e);
        }

        // Try multiple strategies to find the search box
        let searchBoxLocator = null;

        // 1. Strict ID
        try {
            const locator = this.page.locator('#searchboxinput');
            if (await locator.count() > 0 && await locator.isVisible()) searchBoxLocator = locator;
        } catch { }

        // 2. Input name="q"
        if (!searchBoxLocator) {
            try {
                const locator = this.page.locator('input[name="q"]');
                if (await locator.count() > 0 && await locator.isVisible()) searchBoxLocator = locator;
            } catch { }
        }

        // 3. Fallback
        if (!searchBoxLocator) {
            try {
                const locator = this.page.locator('input');
                if (await locator.count() > 0) searchBoxLocator = locator.first();
            } catch { }
        }

        if (!searchBoxLocator) {
            await this.page.screenshot({ path: 'debug-error-searchbox.png' });
            throw new Error('Could not find search box. See debug-error-searchbox.png');
        }

        await searchBoxLocator.first().fill(query);
        await this.randomDelay(500, 1500);
        await this.page.keyboard.press('Enter');

        // Wait for feed (or single result)
        try {
            await Promise.any([
                this.page.waitForSelector('div[role="feed"]', { timeout: 15000 }),
                this.page.waitForSelector('h1', { timeout: 15000 })
            ]);
        } catch (e) {
            console.log('Warning: initial result list potentially not found');
        }
        await this.randomDelay(2000, 4000);
    }

    async scrape(onResult: (place: PlaceResult) => void) {
        if (!this.page) throw new Error('Browser not initialized');

        const feedSelector = 'div[role="feed"]';
        let endOfList = false;
        const scrapedNames = new Set<string>();

        while (!endOfList) {
            // Re-query for items every time to avoid stale elements
            const places = await this.page.$$('div[role="article"]');
            let processedAnyInThisBatch = false;

            for (const place of places) {
                try {
                    const ariaLabel = await place.getAttribute('aria-label');
                    if (ariaLabel && !scrapedNames.has(ariaLabel)) {

                        // Click to open details
                        await place.click();
                        await this.randomDelay(800, 1500);

                        const details = await this.extractDetails(ariaLabel);

                        if (details) {
                            scrapedNames.add(ariaLabel);
                            onResult(details);
                        }

                        // REMOVED: risky "Close" button click that was clearing the search.
                        // On desktop (1366px), the list usually persists on the left.
                        // If the list IS hidden (mobile/narrow), we should look for "Back to results".

                        // Check if list is still visible/present, because details might cover it
                        const listVisible = await this.page.isVisible(feedSelector);
                        if (!listVisible) {
                            // Try to click "Back" button if list is gone
                            const backButton = await this.page.$('button[aria-label="Back"]');
                            if (backButton) {
                                await backButton.click();
                                await this.randomDelay(500, 1000);
                            }
                        }

                        processedAnyInThisBatch = true;
                        // Break inner loop to re-scan DOM, as it might have shifted/updated
                        break;
                    }
                } catch (e) {
                    console.error('Error processing place loop item:', e);
                }
            }

            // If we didn't process any new items in the current viewport/DOM state, we scroll
            if (!processedAnyInThisBatch) {

                // Check for specific "End of list" element
                try {
                    const endTextElement = await this.page.$('span.HlvSq');
                    if (endTextElement) {
                        const text = await endTextElement.innerText();
                        if (text.includes("You've reached the end of the list")) {
                            endOfList = true;
                            console.log("Reached end of list marker.");
                            break;
                        }
                    }
                } catch (e) { }

                // Ensure focus is on the feed before scrolling to prevent stuck scroll
                try {
                    // We don't click because it might open a result. Hover is safer.
                    await this.page.hover(feedSelector);
                } catch (e) { }

                // Scroll down
                await this.page.evaluate((selector) => {
                    const element = document.querySelector(selector);
                    if (element) {
                        element.scrollTop = element.scrollHeight;
                    }
                }, feedSelector);

                await this.randomDelay(1500, 3000);
            }
        }
    }

    private async extractDetails(name: string): Promise<PlaceResult | null> {
        if (!this.page) return null;

        try {
            // Website
            const websiteBtn = await this.page.$('a[data-item-id="authority"]');
            const website = websiteBtn ? await websiteBtn.getAttribute('href') || undefined : undefined;

            // Phone
            const phoneBtn = await this.page.$('button[data-item-id^="phone"]');
            let phone = undefined;
            if (phoneBtn) {
                phone = (await phoneBtn.getAttribute('aria-label')) || undefined;
                phone = phone?.replace('Phone: ', '').trim();
            }

            // Rating and Reviews
            let rating = undefined;
            let reviews = undefined;

            try {
                const ratingEl = await this.page.$('.F7nice span[aria-hidden="true"]');
                if (ratingEl) {
                    const text = await ratingEl.textContent();
                    if (text) rating = parseFloat(text);
                }

                const reviewsEl = await this.page.$('.F7nice span[aria-label*="reviews"]');
                if (reviewsEl) {
                    const label = await reviewsEl.getAttribute('aria-label');
                    if (label) {
                        const match = label.match(/(\d+)/);
                        if (match) reviews = parseInt(match[0]);
                    }
                }
            } catch (e) { }

            // Opening hours
            let hours = undefined;
            try {
                const expandHoursBtn = await this.page.$('span[aria-label="Show open hours for the week"]');
                if (expandHoursBtn) {
                    await expandHoursBtn.click();
                    await this.randomDelay(500, 1000);

                    // Parse the specific table structure
                    const rows = await this.page.$$('table.eK4R0e tr.y0skZc');
                    if (rows.length > 0) {
                        const hoursList = [];
                        for (const row of rows) {
                            try {
                                const dayEl = await row.$('td.ylH6lf');
                                const timeEl = await row.$('td.mxowUb');

                                const day = dayEl ? await dayEl.innerText() : '';
                                const time = timeEl ? await timeEl.getAttribute('aria-label') : '';

                                if (day && time) {
                                    hoursList.push(`${day}: ${time}`);
                                }
                            } catch (e) { }
                        }
                        if (hoursList.length > 0) {
                            hours = hoursList.join(' | ');
                        }
                    }

                    if (!hours) {
                        const hoursTable = await this.page.$('table[role="presentation"]');
                        if (hoursTable) {
                            const hoursText = await hoursTable.innerText();
                            hours = hoursText.replace(/\n/g, ', ');
                        }
                    }
                }

                // Final fallback to summary
                if (!hours) {
                    const hoursElement = await this.page.$('button[data-item-id="openhours"]');
                    hours = hoursElement ? await hoursElement.getAttribute('aria-label') || undefined : undefined;
                }

            } catch (e) { }

            return {
                name,
                website,
                phone,
                rating,
                reviews,
                hours
            };

        } catch (e) {
            console.error('Error extracting details', e);
            return null;
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}
