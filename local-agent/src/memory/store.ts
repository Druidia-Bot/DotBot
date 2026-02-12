/**
 * Local Memory Store
 * 
 * Barrel re-export for all store modules, plus assets.
 * 
 * Directory structure:
 * ~/.bot/
 *   memory/
 *     index.json              - Master index
 *     schemas/                - Category schemas
 *     models/                 - Mental model JSON files
 *     threads/                - Conversation threads
 *   skills/                   - Learned skill JSON files
 */

import { promises as fs } from "fs";
import * as path from "path";
import {
  TEMP_DIR,
  fileExists,
} from "./store-core.js";

// Re-export everything from sub-modules
export { initializeMemoryStore, getMemoryIndex, rebuildMemoryIndex } from "./store-core.js";
export {
  getSchema, saveSchema, addFieldToSchema,
  getMentalModel, getAllMentalModels, saveMentalModel, createMentalModel, deleteMentalModel,
  addBelief, addOpenLoop, resolveOpenLoop, addQuestion, addConstraint,
  searchMentalModels,
  buildModelSkeleton, getModelSkeletons,
  getDeepMemoryIndex, getDeepModel, promoteModel, searchAndPromote,
  mergeMentalModels,
} from "./store-models.js";
export type { ScoredModelEntry, MergeResult } from "./store-models.js";
export {
  getSkill, getAllSkills, saveSkill, createSkill, deleteSkill,
  searchSkills, addSupportingFile, readSupportingFile,
} from "./store-skills.js";
export {
  getThread, getAllThreadSummaries, getL0MemoryIndex,
  updateThread, saveToThread,
  archiveThread, condenseThread, clearAllThreads,
} from "./store-threads.js";
export {
  createTask, updateTask, updateTaskStep,
  getTask, getTasks, getResumableTasks, pruneCompletedTasks,
} from "./store-tasks.js";

// ============================================
// ASSET MANAGEMENT
// ============================================

/**
 * Store an asset temporarily on the client
 */
export async function storeAsset(
  sessionId: string, 
  taskId: string, 
  asset: { data: string; filename: string; assetType: string }
): Promise<string> {
  try {
    const assetDir = path.join(TEMP_DIR, sessionId, taskId);
    await fs.mkdir(assetDir, { recursive: true });
    
    // SEC-03: Sanitize filename to prevent path traversal
    // Reject raw filenames containing traversal patterns BEFORE basename stripping
    if (!asset.filename || asset.filename.includes('..') || /[/\\]/.test(asset.filename)) {
      throw new Error(`Invalid asset filename: ${asset.filename}`);
    }
    const safeName = path.basename(asset.filename);
    if (!safeName || safeName === '.') {
      throw new Error(`Invalid asset filename: ${asset.filename}`);
    }
    const assetPath = path.join(assetDir, safeName);
    // Belt-and-suspenders: verify resolved path is still inside assetDir
    const resolvedAssetPath = path.resolve(assetPath);
    const resolvedAssetDir = path.resolve(assetDir);
    if (!resolvedAssetPath.startsWith(resolvedAssetDir + path.sep) && resolvedAssetPath !== resolvedAssetDir) {
      throw new Error(`Asset path escapes target directory: ${asset.filename}`);
    }
    
    // Decode base64 if needed — require data: prefix or long base64 string with padding
    if (asset.data.startsWith("data:") || (asset.data.length >= 100 && /^[A-Za-z0-9+/]+=*$/.test(asset.data) && asset.data.length % 4 === 0)) {
      const base64Data = asset.data.replace(/^data:[^;]+;base64,/, "");
      await fs.writeFile(assetPath, Buffer.from(base64Data, "base64"));
    } else {
      await fs.writeFile(assetPath, asset.data, "utf-8");
    }
    
    return assetPath;
  } catch (error) {
    console.error(`[Memory] Failed to store asset:`, error);
    throw error;
  }
}

/**
 * Retrieve an asset from the client
 */
export async function retrieveAsset(clientPath: string): Promise<string> {
  try {
    const buffer = await fs.readFile(clientPath);
    return buffer.toString("base64");
  } catch (error) {
    console.error(`[Memory] Failed to retrieve asset ${clientPath}:`, error);
    throw error;
  }
}

/**
 * Cleanup temporary assets
 */
export async function cleanupAssets(sessionId?: string, taskIds?: string[]): Promise<void> {
  try {
    if (sessionId) {
      // Delete entire session folder
      const sessionDir = path.join(TEMP_DIR, sessionId);
      await fs.rm(sessionDir, { recursive: true, force: true });
    } else if (taskIds) {
      // Delete specific task folders
      const sessions = await fs.readdir(TEMP_DIR).catch(() => []);
      for (const session of sessions) {
        for (const taskId of taskIds) {
          const taskDir = path.join(TEMP_DIR, session, taskId);
          await fs.rm(taskDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  } catch (error) {
    console.error(`[Memory] Failed to cleanup assets:`, error);
  }
}
