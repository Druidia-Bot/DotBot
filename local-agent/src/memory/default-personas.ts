/**
 * Default Persona Definitions (Legacy File-Based System)
 * 
 * This module previously created default .md persona files and council path
 * files in ~/.bot/. That system has been replaced by the JSON store in
 * bootstrap.ts which creates the Skill Building Team council.
 * 
 * bootstrapDefaults() is kept as a no-op for backward compatibility
 * with the local-agent index.ts call site.
 */

import { writeKnowledgeFile, readAllKnowledgeFiles } from "./persona-files.js";
import { getDefaultKnowledgeForPersona, getPersonasWithDefaultKnowledge } from "./default-knowledge.js";

// ============================================
// BOOTSTRAP FUNCTION (no-op for personas/paths)
// ============================================

/**
 * Previously created default personas and council paths.
 * Now only bootstraps knowledge documents — personas and councils
 * are created by bootstrapInitialData() in bootstrap.ts.
 */
export async function bootstrapDefaults(): Promise<{ personasCreated: number; pathsCreated: number; knowledgeCreated: number }> {
  const knowledgeCreated = await bootstrapDefaultKnowledge();
  return { personasCreated: 0, pathsCreated: 0, knowledgeCreated };
}

/**
 * Bootstrap knowledge files for personas that have default knowledge.
 * Only writes files that don't already exist.
 */
async function bootstrapDefaultKnowledge(): Promise<number> {
  let created = 0;
  const slugs = getPersonasWithDefaultKnowledge();

  for (const slug of slugs) {
    const existing = await readAllKnowledgeFiles(slug);
    const existingNames = new Set(existing.map(f => f.filename));
    const docs = await getDefaultKnowledgeForPersona(slug);

    for (const doc of docs) {
      if (!existingNames.has(doc.filename) && doc.content) {
        await writeKnowledgeFile(slug, doc.filename, doc.content);
        created++;
      }
    }
  }

  if (created > 0) {
    console.log(`[Bootstrap] Created ${created} default knowledge documents`);
  }

  return created;
}
