import { chromium } from 'playwright';
import { findContactInfo } from '../src/lib/email-scraper';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const url = 'http://www.lago-restaurant.de/';
    console.log(`Starting extraction for ${url}...`);
    const result = await findContactInfo(context, url, console.log);
    console.log('\n--- Extraction Result ---');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
