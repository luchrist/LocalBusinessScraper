let llama: any = null;
let model: any = null;
let isInitializing = false;
let initPromise: Promise<void> | null = null;
let llmAvailable = true;

// Pool configuration
const MAX_SESSIONS = 2;
const sessionPool: { session: any; context: any }[] = [];
const waitingQueue: ((session: { session: any; context: any }) => void)[] = [];

async function initializePool() {
  if (sessionPool.length > 0 || !llmAvailable) return;

  // Use a promise to prevent race conditions during double-initialization
  if (isInitializing) {
     if (initPromise) await initPromise;
     return;
  }

  isInitializing = true;
  initPromise = (async () => {
    try {
      console.log("🚀 Initializing LLM Pool with " + MAX_SESSIONS + " workers...");
      const { getLlama, LlamaChatSession } = await import("node-llama-cpp");
      llama = await getLlama();
      const modelPath = process.env.LLM_MODEL_PATH || "./models/llama-model.gguf";
      
      model = await llama.loadModel({
        modelPath: modelPath,
      });

      // Create distinct contexts and sessions
      for (let i = 0; i < MAX_SESSIONS; i++) {
        console.log(`Creating Worker ${i + 1}...`);
        const context = await model.createContext();
        const session = new LlamaChatSession({
          contextSequence: context.getSequence(),
        });
        sessionPool.push({ session, context });
      }
      console.log("✅ LLM Pool ready.");
    } catch (error) {
      console.error("Failed to initialize LLM Pool:", error);
      llmAvailable = false;
    } finally {
      isInitializing = false;
    }
  })();

  await initPromise;
}

async function getSession() {
  await initializePool();
  if (!llmAvailable || (sessionPool.length === 0 && waitingQueue.length === 0 && !isInitializing)) {
       // Emergency fallback if pool failed
       if (sessionPool.length > 0) return sessionPool.pop();
       return null;
  }

  if (sessionPool.length > 0) {
    return sessionPool.pop();
  }

  // Wait for a free session
  return new Promise<{ session: any; context: any }>((resolve) => {
    waitingQueue.push(resolve);
  });
}

function releaseSession(item: { session: any; context: any }) {
  if (waitingQueue.length > 0) {
    const next = waitingQueue.shift();
    if (next) next(item);
  } else {
    sessionPool.push(item);
  }
}

export async function extractOwnerWithLLM(impressumText: string, businessInfo?: { name?: string, industry?: string }): Promise<string | null> {
  const worker = await getSession();
  if (!worker) {
    console.log("⚠️ LLM not available, skipping AI extraction");
    return null;
  }

  console.log("impressum:", impressumText.substring(0, 1500));

  try {
    const { session } = worker;
    // console.log(`🤖 LLM Worker active (Queue: ${waitingQueue.length})`);

    const prompt = `You are a strict German legal-notice (Impressum) extraction assistant.

Business Name: ${businessInfo?.name || "Unknown"}
Industry: ${businessInfo?.industry || "Unknown"}

Task: Extract the NATURAL PERSON name(s) that represent the business from the text below.
Accept these roles as valid indicators of the right person:
- Inhaber/in, Geschäftsführer/in, Vertreten durch, Geschäftsleitung
- Verantwortliche/r, Verantwortlich im Sinne der DSGVO, Verantwortlich für den Inhalt

Rules:
- Output ONLY natural person names (e.g., "Jasmin Schuster"). Never output addresses, streets, cities, phone numbers, emails, or company/shop names.
- If no natural person is explicitly named in one of the roles above, return names: null.
- If a person is found, set confidence >= 0.7 and include the matched role label.

Return ONLY a JSON object with this format:
{
  "names": "Name 1, Name 2" (or null if none found),
  "confidence": 0.0 to 1.0 (float)
}

Impressum text:
${impressumText.substring(0, 1500)}

JSON Response:`;

    // Note: Do not dispose session here, we reuse it!
    const response = await session.prompt(prompt, {
      maxTokens: 200,
      temperature: 0.1,
    });

    console.log("   🤖 LLM Response:", response);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const result = JSON.parse(jsonMatch[0]);
      const confidenceThreshold = 0.6;

      if (result.confidence < confidenceThreshold) {
        console.log(`   📉 Low confidence (${result.confidence}) for: ${result.names}. Discarding.`);
        return null;
      }

      if (!result.names || result.names === "null" || result.names.length < 3) {
        return null;
      }
      
      // Simple validation: check if returned name looks like a business name
      const forbiddenTerms = [
        'gmbh', 'ug', 'ag', 'limited', 'ltd', 'inc', 'corp', 'co.', ' e.v.', 'restaurant', 'hotel', 'cafe', 'bar', 'bistro', 'praxis', 'kanzlei', 'shop', 'store', 'markt', 'service', 'team'
      ];
      const lowerName = result.names.toLowerCase();
      
      if (forbiddenTerms.some(term => lowerName.includes(term))) {
         console.log(`   🚫 LLM returned a business name/role instead of person: "${result.names}". Discarding.`);
         return null;
      }

      // Check against explicit business info if available
      if (businessInfo?.name && lowerName.includes(businessInfo.name.toLowerCase())) {
          console.log(`   🚫 LLM returned the business name itself: "${result.names}". Discarding.`);
          return null;
      }
      if (businessInfo?.industry && lowerName.includes(businessInfo.industry.toLowerCase())) {
          console.log(`   🚫 LLM returned the industry name: "${result.names}". Discarding.`);
          return null;
      }

      return result.names;
    } catch (parseError) {
      console.error("Failed to parse LLM JSON:", parseError);
      return null;
    }

  } catch (error) {
    console.error("LLM extraction error:", error);
    return null;
  } finally {
    // Return worker to pool
    releaseSession(worker);
  }
}
