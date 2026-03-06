import { chromium } from 'playwright';
import { extractOwnerFromText } from './src/lib/email-scraper';

async function test() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    console.log("Loading page...");
    await page.goto('https://www.elgreco-mingolsheim.de/impressum.html', { waitUntil: 'domcontentloaded' });
    
    // Prefer innerText to preserve structure/newlines, fallback to textContent
    let text = await page.evaluate(() => document.body.innerText).catch(() => null);
    if (!text) text = await page.textContent('body');
    
    console.log(`Extracted text length: ${text?.length}`);
    
    const start = Date.now();
    console.log("Starting owner extraction...");
    console.log("--- TEXT SNIPPET (FIRST 500 CHARACTERS) ---");
    console.log((text || '').substring(0, 500));
    console.log("------------------------------------------");
    const log = (msg: string) => console.log(msg);
    
    const owner = await extractOwnerFromText(text || '', {
      name: 'Restaurant El Greco',
      industry: 'Restaurant'
    }, log);
    
    console.log('\n--- FINAL RESULT ---');
    console.log('Owner:', owner);
    console.log(`Took ${(Date.now() - start)/1000}s`);
  } catch(e) {
    console.error("Test failed", e);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

test();
