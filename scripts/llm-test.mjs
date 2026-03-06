import { getLlama, LlamaChatSession } from "node-llama-cpp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.join(__dirname, "../models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf");

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

        const impressumText = `Home
Über uns
Mittagskarte
Speisekarte
Impressum
Impressum
Anbieterkennzeichnung
Restaurant El Greco
Friedrichstraße 58
76669 Bad Schönborn


E-Mail: info@elgreco-mingolsheim.de
(Reservierungen ausschließlich telefonisch!)
Fon: 0 72 53 - 935 21 93


Verantwortlich für den Inhalt
Panagiotis Panagiotopoulos


Webdesign & Programmierung:
PC-Dok24.de
In der Gründ 5
76646 Bruchsal (Büchenau)


Webseite: www.pc-dok24.de
E-Mail: info@pc-dok24.de
Fon: 0 72 57 - 647 76 05 


Alle Urheber- und Nutzungsrec`;

        const businessInfo = { name: 'Restaurant El Greco', industry: 'Restaurant' };

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
- If you genuinely cannot find any human name representing the business in the text, return names: "".

Return ONLY a JSON object with this format:
{
  "names": "Name 1, Name 2" (or "" if none found),
  "confidence": 0.0 to 1.0 (float)
}

Impressum text:
${impressumText.substring(0, 1500)}

JSON Response:`;

        const jsonResponseGrammar = await llama.createGrammarForJsonSchema({
      type: 'object',
      properties: {
        names: {
          type: 'string',
          description: 'The extracted name, or empty string if none'
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

        console.log("Running inference...");
        const response = await session.prompt(prompt, {
            maxTokens: 500,
            temperature: 0.1,
            grammar: jsonResponseGrammar,
        });

        console.log("Response:", response);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}

main();
