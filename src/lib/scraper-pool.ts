import { logger } from '@/lib/logger';
/**
 * scraper-pool.ts – Reusable browser-worker pool for Google Maps scraping.
 *
 * Design goals
 * ────────────
 *  • Browsers are launched ONCE and kept alive; only the BrowserContext is
 *    recycled after every search (fresh cookies / localStorage).
 *  • After BROWSER_ROTATE_EVERY searches the whole browser process is
 *    replaced so memory doesn't accumulate indefinitely.
 *  • Worker count is derived from available system RAM when no override is
 *    given (UI value always wins).
 *  • acquire() / release() provide simple exclusive locking; callers must
 *    release() even on error, so always wrap in try/finally.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import os from 'os';

const BROWSER_ROTATE_EVERY = 20; // searches before full browser restart

// ─── Stealth init script ──────────────────────────────────────────────────────

const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'platform',  { get: () => 'MacIntel' });

  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (p) =>
    p.name === 'notifications'
      ? Promise.resolve({ state: 'denied' })
      : originalQuery(p);

  window.chrome = { runtime: {} };
`;

// ─── ScraperWorker ────────────────────────────────────────────────────────────

export class ScraperWorker {
  id: number;
  private browser: Browser | null = null;
  context: BrowserContext | null = null;
  page: Page | null = null;
  private searchCount = 0;
  isAvailable = false;  // managed by pool

  constructor(id: number) {
    this.id = id;
  }

  async launch() {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-accelerated-2d-canvas',
        '--disable-infobars',
        '--window-position=0,0',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-web-security',
      ],
    });

    await this._newContext();
  }

  /**
   * Reset after every search: closes current context + page, opens a fresh
   * one (new cookies, localStorage, cache). Browser process stays alive.
   */
  async resetContext() {
    try { await this.page?.close(); } catch {}
    try { await this.context?.close(); } catch {}
    this.page = null;
    this.context = null;

    this.searchCount++;

    // Rotate the whole browser after N searches
    if (this.searchCount >= BROWSER_ROTATE_EVERY) {
      logger.log(`[Worker ${this.id}] Rotating browser after ${this.searchCount} searches`);
      await this._rotateBrowser();
    } else {
      await this._newContext();
    }
  }

  private async _rotateBrowser() {
    try { await this.browser?.close(); } catch {}
    this.browser = null;
    this.searchCount = 0;
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-accelerated-2d-canvas', '--disable-infobars',
        '--window-position=0,0', '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials', '--disable-web-security',
      ],
    });
    await this._newContext();
  }

  private async _newContext() {
    if (!this.browser) throw new Error('Browser not running');

    this.context = await this.browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      timezoneId: 'Europe/Berlin',
      locale: 'en-US',
      permissions: [],
      deviceScaleFactor: 1,
      hasTouch: false,
      javaScriptEnabled: true,
    });

    this.page = await this.context.newPage();

    await this.page.addInitScript(STEALTH_SCRIPT);
  }

  async close() {
    try { await this.page?.close(); } catch {}
    try { await this.context?.close(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

// ─── ScraperPool ──────────────────────────────────────────────────────────────

export class ScraperPool {
  private workers: ScraperWorker[] = [];
  private waiters: ((w: ScraperWorker) => void)[] = [];

  /**
   * Recommend worker count from RAM.
   * UI override always has priority – pass it in as `uiOverride` (1-based).
   */
  static recommendedWorkerCount(uiOverride?: number): number {
    if (uiOverride && uiOverride > 0) return uiOverride;
    const gbRam = os.totalmem() / 1024 ** 3;
    if (gbRam > 16) return 2;
    return 1;
  }

  async initialize(count: number) {
    logger.log(`[Pool] Launching ${count} browser worker(s)…`);
    this.workers = Array.from({ length: count }, (_, i) => new ScraperWorker(i + 1));
    await Promise.all(this.workers.map(w => w.launch()));
    this.workers.forEach(w => (w.isAvailable = true));
    logger.log(`[Pool] All ${count} worker(s) ready`);
  }

  /**
   * Acquire an available worker, waiting until one frees up.
   */
  acquire(): Promise<ScraperWorker> {
    const free = this.workers.find(w => w.isAvailable);
    if (free) {
      free.isAvailable = false;
      return Promise.resolve(free);
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }

  /**
   * Return a worker to the pool after use.
   * Call this in a finally block to guarantee it happens even on error.
   */
  release(worker: ScraperWorker) {
    const waiter = this.waiters.shift();
    if (waiter) {
      // Hand directly to next caller without going back to pool
      waiter(worker);
    } else {
      worker.isAvailable = true;
    }
  }

  async close() {
    logger.log('[Pool] Closing all workers…');
    await Promise.all(this.workers.map(w => w.close()));
    this.workers = [];
  }
}

