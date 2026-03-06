import { parentPort } from 'worker_threads';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';
import path from 'path';
import os from 'os';

let llama = null;
let model = null;
let context = null;
let session = null;
let jsonResponseGrammar = null;
let binaryChoiceGrammar = null;
let isReady = false;

async function init() {
  try {
    llama = await getLlama();
    const gbRam = os.totalmem() / 1024 ** 3;
    const defaultModelFile = gbRam <= 12 ? "qwen2.5-1.5b-instruct-q4_k_m.gguf" : "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf";
    const modelPath = process.env.LLM_MODEL_PATH || path.join(process.cwd(), "models", defaultModelFile);
    
    model = await llama.loadModel({
      modelPath: modelPath,
    });
    
    context = await model.createContext();
    session = new LlamaChatSession({
      contextSequence: context.getSequence(),
    });

    // Constrain generations to the exact JSON object shape expected by the extractor.
    jsonResponseGrammar = await llama.createGrammarForJsonSchema({
      type: 'object',
      properties: {
        names: {
          type: 'string',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
      },
      required: ['names', 'confidence'],
      additionalProperties: false,
    });

    binaryChoiceGrammar = await llama.createGrammarForJsonSchema({
      type: 'object',
      properties: {
        choice: {
          enum: ['line1', 'line2'],
        },
      },
      required: ['choice'],
      additionalProperties: false,
    });

    isReady = true;
    parentPort.postMessage({ type: 'READY' });
    
    // Process any queued messages
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      await processMessage(msg);
    }
  } catch (error) {
    parentPort.postMessage({ type: 'ERROR', id: null, error: error.message });
  }
}

const messageQueue = [];

async function processMessage(msg) {
  try {
    // Reset chat history to avoid bleeding context or running out of tokens
    await session.setChatHistory([]);
    
    // prompt the session
    const isBinaryChoice = msg.type === 'BINARY_CHOICE';
    const response = await session.prompt(msg.prompt, {
      maxTokens: isBinaryChoice ? 40 : 200,
      temperature: isBinaryChoice ? 0 : 0.1,
      grammar: isBinaryChoice ? binaryChoiceGrammar : jsonResponseGrammar,
    });

    parentPort.postMessage({ type: 'RESULT', id: msg.id, data: response });
  } catch (err) {
    parentPort.postMessage({ type: 'ERROR', id: msg.id, error: err.message });
  }
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'PROMPT' || msg.type === 'BINARY_CHOICE') {
    if (!isReady) {
      messageQueue.push(msg);
    } else {
      await processMessage(msg);
    }
  }
});

// Start initialization
init();
