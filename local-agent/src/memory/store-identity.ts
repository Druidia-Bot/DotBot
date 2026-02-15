/**
 * Agent Identity Store
 * 
 * Manages the "me" construct — the agent's self-model stored at ~/.bot/me.json.
 * Contains core personality, ethics, code of conduct, human instructions,
 * and non-secure properties.
 * 
 * Updated ONLY via programmatic add/remove operations (never raw LLM writes).
 * The LLM emits identity_* instructions, this module applies them.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { DOTBOT_DIR, fileExists, readJson, writeJson } from "./store-core.js";
import type { AgentIdentity } from "./types.js";

// ============================================
// PATHS
// ============================================

const IDENTITY_PATH = path.join(DOTBOT_DIR, "me.json");

// ============================================
// DEFAULT IDENTITY
// ============================================

function createDefaultIdentity(): AgentIdentity {
  const now = new Date().toISOString();
  return {
    name: "Dot",
    role: "Personal AI assistant",
    traits: [
      "I complete tasks before starting new ones",
      "I respond politely and professionally",
      "I like to build things and solve problems",
      "I am proactive about suggesting improvements",
      "I am honest about what I can and cannot do",
      "I think from first principles — I break problems down to their core constraints and mechanics before attempting solutions",
      "I form testable hypotheses and work incrementally — if a hypothesis fails, I re-evaluate and adjust rather than blindly iterating",
      "I always have a plan with a testable outcome and revise that plan based on incremental test results",
      "I am resourceful — I predict multiple paths to a goal and pursue the most promising one based on evidence",
      "I offload simple sub-tasks to the local LLM when possible to save cloud tokens — don't force it, but use it for classification, summarization, keyword extraction, and simple formatting",
    ],
    ethics: [
      "Never share user data without explicit consent",
      "Never execute destructive operations without confirmation",
      "Always be honest about capabilities and limitations",
      "Refuse requests that could cause harm to people or systems",
      "Respect user privacy — never log or transmit personal data",
      "Do not impersonate real people or organizations",
    ],
    codeOfConduct: [
      "Respond politely and professionally at all times",
      "Complete tasks thoroughly before moving on",
      "Ask for clarification when uncertain rather than guessing",
      "Provide sources and evidence when making claims",
      "Admit mistakes promptly and correct them",
      "Keep responses concise unless detail is requested",
      "Respect the user's time — don't over-explain",
      "Never blindly iterate — always have a testable hypothesis before each attempt",
      "When stuck, step back to first principles: identify core constraints, understand the mechanics, then predict a solution",
      "Revise the plan based on incremental test results — don't repeat failed approaches without understanding why they failed",
    ],
    properties: {},
    importiantPaths: {
      dotbotHome: `${DOTBOT_DIR} | Root of all DotBot data — memory, skills, tasks, config`,
      agentWorkspaces: `${path.join(DOTBOT_DIR, "agent-workspaces")} | Where spawned agents store their workspace files (task.json, research/, output/)`,
      memory: `${path.join(DOTBOT_DIR, "memory")} | Mental models, threads, schemas, and the memory index`,
      memoryModels: `${path.join(DOTBOT_DIR, "memory", "models")} | Hot (active) mental model JSON files`,
      deepMemory: `${path.join(DOTBOT_DIR, "memory", "deep")} | Demoted/archived mental models (cold storage)`,
      skills: `${path.join(DOTBOT_DIR, "skills")} | Reusable skill definitions (.md files)`,
      sourceCode: `${process.env.DOTBOT_INSTALL_DIR || "C:\\Program Files\\.bot"} | DotBot source code repository (server + local-agent + client)`,
    },
    humanInstructions: [],
    communicationStyle: [
      "concise",
      "direct",
      "friendly",
    ],
    version: 1,
    createdAt: now,
    lastUpdatedAt: now,
  };
}

// ============================================
// CRUD
// ============================================

/**
 * Load the agent identity. Returns null if me.json doesn't exist.
 */
export async function loadIdentity(): Promise<AgentIdentity | null> {
  if (!await fileExists(IDENTITY_PATH)) return null;
  try {
    return await readJson<AgentIdentity>(IDENTITY_PATH);
  } catch {
    return null;
  }
}

/**
 * Save the agent identity to disk. Bumps version and lastUpdatedAt.
 */
export async function saveIdentity(identity: AgentIdentity): Promise<void> {
  identity.lastUpdatedAt = new Date().toISOString();
  await writeJson(IDENTITY_PATH, identity);
}

/**
 * Bootstrap the default identity if me.json doesn't exist yet.
 * Returns true if a new identity was created.
 */
export async function bootstrapIdentity(): Promise<boolean> {
  if (await fileExists(IDENTITY_PATH)) return false;
  const identity = createDefaultIdentity();
  await writeJson(IDENTITY_PATH, identity);
  console.log("[Identity] Created default identity at ~/.bot/me.json");
  return true;
}

// ============================================
// SKELETON (compact representation for context injection)
// ============================================

/**
 * Build a compact skeleton of the identity for context injection.
 * Keeps it small — just the key structure and short values.
 */
export function buildIdentitySkeleton(identity: AgentIdentity): string {
  const lines: string[] = [
    `Name: ${identity.name}`,
    `Role: ${identity.role}`,
    `Traits: ${identity.traits.join("; ")}`,
    `Ethics: ${identity.ethics.join("; ")}`,
    `Code of Conduct: ${identity.codeOfConduct.join("; ")}`,
    `Communication Style: ${identity.communicationStyle.join(", ")}`,
  ];

  if (identity.humanInstructions.length > 0) {
    lines.push(`Human Instructions: ${identity.humanInstructions.join("; ")}`);
  }

  const propKeys = Object.keys(identity.properties);
  if (propKeys.length > 0) {
    const propStr = propKeys.map(k => `${k}: ${identity.properties[k]}`).join("; ");
    lines.push(`Properties: ${propStr}`);
  }

  const pathKeys = Object.keys(identity.importiantPaths || {});
  if (pathKeys.length > 0) {
    lines.push("Important Paths:");
    for (const k of pathKeys) {
      const raw = identity.importiantPaths[k];
      const [p, desc] = raw.includes(" | ") ? raw.split(" | ", 2) : [raw, ""];
      lines.push(`  ${k}: ${p}${desc ? ` — ${desc}` : ""}`);
    }
  }

  return lines.join("\n");
}

// ============================================
// PROGRAMMATIC MUTATIONS (used by instruction-applier)
// ============================================

/**
 * Add an item to an array field if it doesn't already exist.
 * Returns true if the item was added.
 */
async function addToArray(field: keyof AgentIdentity, value: string): Promise<boolean> {
  const identity = await loadIdentity();
  if (!identity) return false;

  const arr = identity[field];
  if (!Array.isArray(arr)) return false;
  if (arr.includes(value)) return false;

  arr.push(value);
  identity.version++;
  await saveIdentity(identity);
  return true;
}

/**
 * Remove an item from an array field.
 * Returns true if the item was removed.
 */
async function removeFromArray(field: keyof AgentIdentity, value: string): Promise<boolean> {
  const identity = await loadIdentity();
  if (!identity) return false;

  const arr = identity[field];
  if (!Array.isArray(arr)) return false;

  const idx = arr.findIndex(item => item.toLowerCase() === value.toLowerCase());
  if (idx === -1) return false;

  arr.splice(idx, 1);
  identity.version++;
  await saveIdentity(identity);
  return true;
}

// Trait operations
export const addTrait = (value: string) => addToArray("traits", value);
export const removeTrait = (value: string) => removeFromArray("traits", value);

// Ethics operations
export const addEthic = (value: string) => addToArray("ethics", value);
export const removeEthic = (value: string) => removeFromArray("ethics", value);

// Code of conduct operations
export const addConduct = (value: string) => addToArray("codeOfConduct", value);
export const removeConduct = (value: string) => removeFromArray("codeOfConduct", value);

// Human instruction operations
export const addInstruction = (value: string) => addToArray("humanInstructions", value);
export const removeInstruction = (value: string) => removeFromArray("humanInstructions", value);

// Communication style operations
export const addCommunicationStyle = (value: string) => addToArray("communicationStyle", value);
export const removeCommunicationStyle = (value: string) => removeFromArray("communicationStyle", value);

/**
 * Set a non-secure property.
 */
export async function setProperty(key: string, value: string): Promise<boolean> {
  const identity = await loadIdentity();
  if (!identity) return false;

  identity.properties[key] = value;
  identity.version++;
  await saveIdentity(identity);
  return true;
}

/**
 * Remove a property.
 */
export async function removeProperty(key: string): Promise<boolean> {
  const identity = await loadIdentity();
  if (!identity) return false;
  if (!(key in identity.properties)) return false;

  delete identity.properties[key];
  identity.version++;
  await saveIdentity(identity);
  return true;
}

/**
 * Set the agent's name.
 */
export async function setName(value: string): Promise<boolean> {
  const identity = await loadIdentity();
  if (!identity) return false;

  identity.name = value;
  identity.version++;
  await saveIdentity(identity);
  return true;
}

/**
 * Set the agent's role description.
 */
export async function setRole(value: string): Promise<boolean> {
  const identity = await loadIdentity();
  if (!identity) return false;

  identity.role = value;
  identity.version++;
  await saveIdentity(identity);
  return true;
}
