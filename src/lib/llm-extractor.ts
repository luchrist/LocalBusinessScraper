import { logger } from '@/lib/logger';
import { Worker } from 'worker_threads';
import path from 'path';

let llmWorker: Worker | null = null;
let isInitializing = false;
let llmAvailable = true;
let initPromise: Promise<void> | null = null;

let jobId = 0;
const pendingTasks = new Map<number, { resolve: (value: string) => void, reject: (reason?: unknown) => void }>();

let isWorkerBusy = false;
const workerQueue: (() => void)[] = [];
const activeSiteRequests = new Map<string, Promise<string | null>>();
const resolvedOwnerBySite = new Map<string, string>();

function normalizeSiteKey(siteKey?: string): string | null {
  if (!siteKey) return null;
  return siteKey.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase().trim() || null;
}

async function acquireWorkerLock(): Promise<void> {
  if (!isWorkerBusy) {
    isWorkerBusy = true;
    return;
  }
  return new Promise<void>((resolve) => {
    workerQueue.push(resolve);
  });
}

function releaseWorkerLock(): void {
  if (workerQueue.length > 0) {
    const next = workerQueue.shift();
    if (next) next();
  } else {
    isWorkerBusy = false;
  }
}

async function getWorker(): Promise<Worker | null> {
  if (!llmAvailable) return null;

  if (isInitializing && initPromise) {
    await initPromise;
    return llmWorker;
  }

  if (llmWorker) return llmWorker;

  isInitializing = true;
  initPromise = new Promise<void>((resolve) => {
    logger.log("🚀 Spawning LLM Worker thread...");
    const workerPath = path.resolve(process.cwd(), 'src/lib/llm-worker.mjs');
    llmWorker = new Worker(workerPath);

    llmWorker.on('message', (msg) => {
      if (msg.type === 'READY') {
        logger.log("✅ LLM Worker is ready.");
        resolve();
      } else if (msg.type === 'ERROR' && msg.id === null) {
         logger.error("LLM Worker initialization failed:", msg.error);
         llmAvailable = false;
         llmWorker = null;
         resolve();
      } else if (msg.type === 'RESULT' || msg.type === 'ERROR') {
        const task = pendingTasks.get(msg.id);
        if (task) {
          if (msg.type === 'RESULT') task.resolve(msg.data);
          if (msg.type === 'ERROR') task.reject(new Error(msg.error));
          pendingTasks.delete(msg.id);
        }
      }
    });

    llmWorker.on('error', (err) => {
      logger.error("Worker error:", err);
      llmAvailable = false;
      llmWorker = null;
      resolve();
    });

    llmWorker.on('exit', () => {
      llmWorker = null;
    });
  });

  await initPromise;
  isInitializing = false;
  return llmWorker;
}

export async function extractOwnerWithLLM(
  impressumText: string,
  businessInfo?: { name?: string, industry?: string },
  queueOptions: { siteKey?: string } = {}
): Promise<string | null> {
  const siteKey = normalizeSiteKey(queueOptions.siteKey);
  if (siteKey) {
    const cachedOwner = resolvedOwnerBySite.get(siteKey);
    if (cachedOwner) return cachedOwner;

    const activeRequest = activeSiteRequests.get(siteKey);
    if (activeRequest) {
      logger.log(`   🧵 Reusing queued LLM task for site: ${siteKey}`);
      return activeRequest;
    }
  }

  const runTask = async (): Promise<string | null> => {
  const worker = await getWorker();
  if (!worker) {
    logger.log("⚠️ LLM not available, skipping AI extraction");
    return null;
  }

  await acquireWorkerLock();
  try {
    const prompt = `You are an intelligent German Impressum parser.

Task: Extract the NATURAL PERSON name(s) that represent the business from the impressum text below.
Look for names associated with these roles or contexts:
- Inhaber/in, Geschäftsführer/in, Vertreten durch, Geschäftsleitung
- Verantwortliche/r, Verantwortlich im Sinne der DSGVO, Verantwortlich für den Inhalt, Leitung, Manager
- A natural person name appearing near the business name or "Impressum" heading.
Note: Names can be of any origin (German, Greek, Turkish, etc.) and might not always have a clear title positioned directly next to them.

Wir suchen einen Ansprechpartner von dem Unternehmen: "${businessInfo?.name || 'Unbekannt'}", das in der Branche "${businessInfo?.industry || 'Unbekannt'}" tätig ist.

Rules:
- Output ONLY natural person names (e.g., "Jasmin Schuster", "Panagiotis Panagiotopoulos"). 
- Never output addresses, streets, cities, phone numbers, emails, company/shop names, organizations, venues, clubs, restaurants, associations, teams, locations, events, or anything containing digits.
- If you genuinely cannot find any human name representing the business in the text, return names: "null".

Return ONLY a JSON object with this format:
{
  "names": "Name 1, Name 2" (or "null" if none found),
  "confidence": 0.0 to 1.0 (float)
}

Impressum text:
${impressumText.substring(0, 1500)}

JSON Response:`;

    const id = ++jobId;
    
    // Send task to worker
    worker.postMessage({ type: 'PROMPT', id, prompt });

    // Wait for response from worker with timeout
    const response: string = await new Promise((resolve, reject) => {
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        pendingTasks.delete(id);
        reject(new Error("LLM Worker response timeout"));
      }, 45000);

      pendingTasks.set(id, { 
        resolve: (val) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutId);
          resolve(val);
        }, 
        reject: (err) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });

    logger.log("   🤖 LLM Response:", response);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const result = JSON.parse(jsonMatch[0]);
      const confidenceThreshold = 0.6;

      if (result.confidence < confidenceThreshold) {
        logger.log(`   📉 Low confidence (${result.confidence}) for: ${result.names}. Discarding.`);
        return null;
      }

      if (!result.names || result.names.trim().toLowerCase() === "null" || result.names.trim().toLowerCase() === "none") {
        logger.log(`   🚫 LLM returned no valid names ("${result.names}"). Acting as not found.`);
        return null;
      }

      // Remove literal "null" or "none" that the LLM might have included as part of a list
      let cleanedNames = result.names
        .replace(/\bnull\b/ig, '')
        .replace(/\bnone\b/ig, '');
      
      // Clean up stray commas or multiple spaces
      cleanedNames = cleanedNames
        .split(',')
        .map((n: string) => n.trim())
        .filter(Boolean)
        .join(', ');

      if (!cleanedNames || cleanedNames.length < 3) {
        return null;
      }
      
      // Simple validation: check if returned name looks like a business name
      const forbiddenTerms = [
        'gmbh', 'ug', 'ag', 'limited', 'ltd', 'inc', 'corp', 'co.', 'e.v.', 'ev', 'club', 'verein', 'vfr', 'sv', 'fc', 'fv', 'restaurant', 'hotel', 'cafe', 'bar', 'bistro', 'praxis', 'kanzlei', 'shop', 'store', 'markt', 'service', 'team'
      ];
      const lowerName = cleanedNames.toLowerCase();

      // Check for years (e.g. 2024, 2025)
      if (/\b(19|20)\d{2}\b/.test(lowerName)) {
         logger.log(`   🚫 LLM returned a name with a year: "${cleanedNames}". Discarding.`);
         return null;
      }

      // Use regex with lookarounds to ensure terms are matched only as whole words or separated by non-letters
      // \p{L} matches any Unicode letter, effectively ignoring matches inside words (e.g. "Panagiotis" vs "AG")
      const escapedTerms = forbiddenTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const pattern = `(?<!\\p{L})(${escapedTerms.join('|')})(?!\\p{L})`;
      
      if (new RegExp(pattern, 'iu').test(lowerName)) {
         logger.log(`   🚫 LLM returned a business name/role instead of person: "${cleanedNames}". Discarding.`);
         return null;
      }

      // Check against explicit business info if available
      if (businessInfo?.name && lowerName.includes(businessInfo.name.toLowerCase())) {
          logger.log(`   🚫 LLM returned the business name itself: "${cleanedNames}". Discarding.`);
          return null;
      }
      if (businessInfo?.industry && lowerName.includes(businessInfo.industry.toLowerCase())) {
          logger.log(`   🚫 LLM returned the industry name: "${cleanedNames}". Discarding.`);
          return null;
      }

      return cleanedNames;
    } catch (parseError) {
      logger.error("Failed to parse LLM JSON:", parseError);
      return null;
    }

  } catch (error) {
    logger.error("LLM extraction error:", error);
    return null;
  } finally {
    releaseWorkerLock();
  }
  };

  const taskPromise = runTask();
  if (siteKey) {
    activeSiteRequests.set(siteKey, taskPromise);
  }

  try {
    const owner = await taskPromise;
    if (siteKey && owner) {
      resolvedOwnerBySite.set(siteKey, owner);
      logger.log(`   ✅ LLM queue cleared for site after owner result: ${siteKey}`);
    }
    return owner;
  } finally {
    if (siteKey) {
      activeSiteRequests.delete(siteKey);
    }
  }
}

export async function chooseNaturalPersonBetweenTwoLines(
  line1: string,
  line2: string,
  context?: { cueLabel?: string; businessName?: string; industry?: string }
): Promise<string | null> {
  const worker = await getWorker();
  if (!worker) {
    logger.log('⚠️ LLM not available for two-line owner disambiguation');
    return null;
  }

  await acquireWorkerLock();
  try {
    const prompt = `You are deciding between two candidate lines from a German Impressum.

Task:
- Choose exactly one candidate that sounds more like a natural person name.

Context:
- Cue label: ${context?.cueLabel || 'unknown'}
- Business: ${context?.businessName || 'unknown'}
- Industry: ${context?.industry || 'unknown'}

Candidate line1: ${line1}
Candidate line2: ${line2}

Rules:
- Prefer a natural person name.
- Do not prefer addresses, legal entities, or company names.
- Return only JSON with this exact shape:
{"choice":"line1"} or {"choice":"line2"}`;

    const id = ++jobId;
    worker.postMessage({ type: 'BINARY_CHOICE', id, prompt });

    const response: string = await new Promise((resolve, reject) => {
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        pendingTasks.delete(id);
        reject(new Error("LLM Worker response timeout"));
      }, 30000);

      pendingTasks.set(id, { 
        resolve: (val) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutId);
          resolve(val);
        }, 
        reject: (err) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });

    const parsed = JSON.parse(response.trim()) as { choice?: 'line1' | 'line2' };
    if (parsed.choice === 'line1') return line1;
    if (parsed.choice === 'line2') return line2;
    return null;
  } catch (error) {
    logger.error('Two-line owner disambiguation failed:', error);
    return null;
  } finally {
    releaseWorkerLock();
  }
}