import { getLlama, LlamaChatSession } from "node-llama-cpp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.join(__dirname, "../models/qwen2.5-1.5b-instruct-q4_k_m.gguf");

async function main() {
    console.log("Loading model from:", modelPath);

    try {
        const llama = await getLlama();
        const model = await llama.loadModel({
            modelPath: modelPath,
        });
        
        const context = await model.createContext();
        const session = new LlamaChatSession({
            contextSequence: context.getSequence(),
        });

        const impressumText = `
            Impressum
            Angaben gemäß § 5 TMG
            Musterfirma GmbH
            Musterstraße 1
            12345 Musterstadt
            
            Vertreten durch:
            Max Mustermann
            
            Kontakt
            Telefon: +49 (0) 123 44 55 66
            E-Mail: info@musterfirma.de
        `;

        const prompt = `Extract the owner/manager name from the following Impressum text. Return ONLY the name(s), nothing else. If multiple names, separate with comma. If no name found, return "null".

Impressum text:
${impressumText}

Owner name(s):`;

        console.log("Running inference...");
        const response = await session.prompt(prompt, {
            maxTokens: 50,
            temperature: 0.1,
        });

        console.log("Response:", response);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}

main();
