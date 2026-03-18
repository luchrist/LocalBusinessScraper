import { GoogleMapsScraper } from './src/lib/maps-scraper.js';
import { chromium } from 'playwright';
async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const scraper = new GoogleMapsScraper(page, undefined, undefined, [], []);
  await scraper.search("München", "Restaurant");
  for await (const place of scraper.scrape()) {
    console.log(place);
    break;
  }
  await browser.close();
}
run();
