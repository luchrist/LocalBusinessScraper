import { NextRequest, NextResponse } from 'next/server';
import { chromium } from 'playwright';

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const OBFUSCATED_EMAIL_REGEX = /([\w.+-]+)\s*(?:@|\s*(?:\(?at\)?|\[at\]|\{at\}|at|AT|ät))\s*([A-Za-z0-9.-]+)\.([A-Za-z]{2,})/gi;
const COMMON_PROVIDERS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'web.de', 'gmx.de', 'gmx.net'];

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json({ error: 'URL fehlt' }, { status: 400 });
    }

    const logs: string[] = [];
    const log = (message: string) => {
      console.log(message);
      logs.push(message);
    };

    log(`🕷️  Starting email search for: ${url}`);
    
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const visited = new Set<string>();
    const baseUrl = new URL(url);
    const domain = baseUrl.hostname;

    let foundEmail: string | null = null;

    try {
      // Main page
      log(`🔎 Scanning main page...`);
      const email = await searchPageForEmailWithLogs(page, url, domain, log);
      if (email) {
        log(`✅ Email found on main page: ${email}`);
        foundEmail = email;
      }

      if (!foundEmail) {
        // Subpages
        log(`📄 Fetching subpages...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        const rawLinks: string[] = await page.$$eval('a[href]', (anchors: HTMLAnchorElement[]) =>
          anchors
            .map((a: HTMLAnchorElement) => a.getAttribute('href') || '')
            .filter((href: string) => href.trim().length > 0)
        );

        log(`🔗 Found ${rawLinks.length} links on page`);

        const subpages = rawLinks
          .map(link => {
            try {
              return new URL(link, baseUrl).href;
            } catch {
              return null;
            }
          })
          .filter((link): link is string => {
            if (!link) return false;
            try {
              const linkUrl = new URL(link);
              return linkUrl.hostname === domain && !visited.has(link);
            } catch {
              return false;
            }
          });

        log(`📋 Checking ${subpages.length} subpages for emails`);

        for (const link of subpages) {
          visited.add(link);
          log(`\n   🔍 Checking: ${link}`);
          const subEmail = await searchPageForEmailWithLogs(page, link, domain, log);
          if (subEmail) {
            log(`✅ Email found on subpage: ${subEmail}`);
            foundEmail = subEmail;
            break;
          }
        }

        if (!foundEmail) {
          log(`⚠️  No email found after checking ${subpages.length + 1} pages`);
        }
      }
    } catch (error) {
      log(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      await page.close();
      await browser.close();
    }

    return NextResponse.json({
      url,
      email: foundEmail,
      logs,
    });
  } catch (error) {
    console.error('Test error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unbekannter Fehler' },
      { status: 500 }
    );
  }
}

async function searchPageForEmailWithLogs(
  page: any,
  url: string,
  domain: string,
  log: (message: string) => void
): Promise<string | null> {
  try {
    log(`   📲 Loading: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const text = await page.textContent('body');

    if (!text) {
      log(`   ⚠️  No text content found on page`);
      return null;
    }

    const directEmails = text?.match(EMAIL_REGEX) || [];
    log(`   📧 Direct emails found: ${directEmails.length}`);
    if (directEmails.length > 0) {
      log(`      Found: ${directEmails.join(', ')}`);
    }

    const obfuscatedEmails: string[] = [];
    if (text) {
      let match: RegExpExecArray | null;
      while ((match = OBFUSCATED_EMAIL_REGEX.exec(text)) !== null) {
        const candidate = `${match[1]}@${match[2]}.${match[3]}`;
        obfuscatedEmails.push(candidate);
      }
    }

    log(`   🔐 Obfuscated emails found: ${obfuscatedEmails.length}`);
    if (obfuscatedEmails.length > 0) {
      log(`      Found: ${obfuscatedEmails.join(', ')}`);
    }

    const emails = [...directEmails, ...obfuscatedEmails];

    const getDomainWithoutTLD = (fullDomain: string): string => {
      const normalized = fullDomain.replace(/^www\./, '');
      const parts = normalized.split('.');
      return parts.length > 1 ? parts.slice(0, -1).join('.') : normalized;
    };

    const domainWithoutTLD = getDomainWithoutTLD(domain);
    log(`   🔍 Validating against domain: ${domain} (base: ${domainWithoutTLD})`);

    for (const email of emails) {
      const emailDomain = email.split('@')[1].toLowerCase();
      const emailDomainWithoutTLD = getDomainWithoutTLD(emailDomain);

      log(`      Checking ${email}:`);
      log(`         Email domain base: "${emailDomainWithoutTLD}"`);
      log(`         Website domain base: "${domainWithoutTLD}"`);
      log(`         Is common provider: ${COMMON_PROVIDERS.includes(emailDomain)}`);

      if (emailDomainWithoutTLD === domainWithoutTLD || COMMON_PROVIDERS.includes(emailDomain)) {
        log(`      ✅ ACCEPTED: ${email}`);
        return email;
      } else {
        log(`      ❌ REJECTED: ${email} - domain mismatch`);
      }
    }
  } catch (error) {
    log(`   ⚠️  Failed to load page: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return null;
}
