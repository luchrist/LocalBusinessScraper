let llama: any = null;
let model: any = null;
let context: any = null;
let llmAvailable = true;

const llmLock = {
  queue: Promise.resolve() as Promise<any>,
  async execute<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => task());
    this.queue = result.catch(() => {});
    return result;
  },
};

async function initializeLLM() {
  if (llama && model && context) return { llama, model, context };
  if (!llmAvailable) return null;
  
  try {
    const { getLlama } = await import("node-llama-cpp");
    llama = await getLlama();
    const modelPath = process.env.LLM_MODEL_PATH || "./models/llama-model.gguf";
    
    model = await llama.loadModel({
      modelPath: modelPath,
    });
    
    context = await model.createContext();
    
    return { llama, model, context };
  } catch (error) {
    console.error("Failed to initialize LLM:", error);
    llmAvailable = false;
    return null;
  }
}

export async function extractOwnerWithLLM(impressumText: string): Promise<string | null> {
  return llmLock.execute(async () => {
    try {
      const init = await initializeLLM();
      if (!init) {
        console.log("⚠️ LLM not available, skipping AI extraction");
        return null;
      }
      
      const { context } = init;
      const { LlamaChatSession } = await import("node-llama-cpp");
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
      });
      
      try {
        const prompt = `You are a data extraction assistant. Extract the owner/manager names (Geschäftsführer, Inhaber, etc.) from the Impressum text below.
        
Return ONLY a JSON object with this format:
{
  "names": "Name 1, Name 2" (or null if none found),
  "confidence": 0.0 to 1.0 (float)
}

Impressum text:
${impressumText.substring(0, 1500)}

JSON Response:`;
        
        const response = await session.prompt(prompt, {
          maxTokens: 200,
          temperature: 0.1,
        });
        
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

          return result.names;
        } catch (parseError) {
          console.error("Failed to parse LLM JSON:", parseError);
          return null;
        }

      } finally {
        session.dispose();
      }
    } catch (error) {
      console.error("LLM extraction error:", error);
      return null;
    }
  });
}
