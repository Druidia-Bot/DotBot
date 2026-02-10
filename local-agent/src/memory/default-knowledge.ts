/**
 * Default Knowledge Documents
 * 
 * Knowledge documents for default personas.
 * Content lives in separate .md files under default-content/knowledge/.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_SRC_DIR = path.join(__dirname, "default-content", "knowledge");

export interface DefaultKnowledgeDoc {
  personaSlug: string;
  filename: string;
  /** Filename in default-content/knowledge/ directory to read content from */
  sourceFile: string;
  /** Populated at runtime by reading sourceFile */
  content?: string;
}

export const DEFAULT_KNOWLEDGE: DefaultKnowledgeDoc[] = [
  // Skill Writer — reference for the SKILL.md standard
  {
    personaSlug: "skill-writer",
    filename: "skill-md-format.md",
    sourceFile: "skill-md-format-knowledge.md",
  },
];

/**
 * Get default knowledge documents for a persona, reading content from default-content/knowledge/ files.
 * Returns cloned objects — never mutates the module-level DEFAULT_KNOWLEDGE array.
 */
export async function getDefaultKnowledgeForPersona(personaSlug: string): Promise<DefaultKnowledgeDoc[]> {
  const matches = DEFAULT_KNOWLEDGE.filter(doc => doc.personaSlug === personaSlug);
  const results: DefaultKnowledgeDoc[] = [];
  for (const doc of matches) {
    const filePath = path.join(KNOWLEDGE_SRC_DIR, doc.sourceFile);
    const content = await fs.readFile(filePath, "utf-8");
    results.push({ ...doc, content });
  }
  return results;
}

/**
 * Get all unique persona slugs that have default knowledge
 */
export function getPersonasWithDefaultKnowledge(): string[] {
  return [...new Set(DEFAULT_KNOWLEDGE.map(doc => doc.personaSlug))];
}
