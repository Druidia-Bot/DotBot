/**
 * Short Path — Fast Bypass for Simple Messages
 *
 * Runs BEFORE the receptionist/orchestrator. Catches messages that
 * don't need the full pipeline:
 * - Greetings ("hey", "hello", "good morning")
 * - Acknowledgments ("ok", "thanks", "got it")
 * - Simple status checks ("are you there?", "you online?")
 * - Single-word/emoji messages
 * - Quick memory questions ("what's my son's name?")
 *
 * Uses rule-based matching first (zero LLM cost), then an LLM
 * classifier for ambiguous cases.
 *
 * When short path handles a message, the user gets a response in
 * milliseconds instead of the 2-5s full pipeline.
 */

import { createComponentLogger } from "../logging.js";
import { resolveModelAndClient } from "./execution.js";
import type { ILLMClient } from "../llm/providers.js";
import type { AgentRunnerOptions } from "./runner-types.js";
import type { EnhancedPromptRequest } from "../types/agent.js";

const log = createComponentLogger("short-path");

// ============================================
// TYPES
// ============================================

export interface ShortPathResult {
  /** Whether the short path handled this message */
  isShortPath: boolean;
  /** The response to send (only set if isShortPath) */
  response?: string;
  /** Classification for logging */
  reason?: "greeting" | "acknowledgment" | "status_check" | "farewell" | "emoji" | "memory_lookup" | "conversational";
}

// ============================================
// RULE-BASED PATTERNS
// ============================================

const GREETINGS = new Set([
  "hey", "hi", "hello", "yo", "sup", "heya", "hiya", "howdy",
  "good morning", "good afternoon", "good evening",
  "morning", "afternoon", "evening",
  "whats up", "what's up", "wassup", "whaddup",
  "hey there", "hi there", "hello there",
  "hey dot", "hi dot", "hello dot",
]);

const ACKNOWLEDGMENTS = new Set([
  "ok", "okay", "k", "kk",
  "thanks", "thank you", "thx", "ty", "cheers",
  "got it", "understood", "roger", "copy",
  "cool", "nice", "great", "awesome", "perfect",
  "sounds good", "works for me", "fair enough",
  "yes", "yeah", "yep", "yup", "sure",
  "no", "nope", "nah",
]);

const STATUS_CHECKS = new Set([
  "are you there", "you there", "you online",
  "are you awake", "you awake", "alive",
  "hello?", "anyone there", "bot",
  "ping", "test", "testing",
]);

const FAREWELLS = new Set([
  "bye", "goodbye", "goodnight", "good night",
  "see ya", "see you", "later", "peace",
  "gotta go", "gtg", "brb", "cya",
  "night", "nite",
]);

/** Patterns that suggest a quick memory lookup */
const MEMORY_QUESTION_PATTERNS = [
  /^what(?:'s| is) my\b/i,
  /^when(?:'s| is) my\b/i,
  /^who(?:'s| is) my\b/i,
  /^how old is my\b/i,
  /^do you (?:know|remember)\b/i,
  /^what do you know about\b/i,
];

// ============================================
// SHORT PATH LOGIC
// ============================================

/**
 * Attempt to handle a message via the short path.
 * Returns { isShortPath: true, response } if the message was handled.
 * Returns { isShortPath: false } if the full pipeline should process it.
 *
 * @param activeAgentCount — Number of active/completed agents in the router.
 *   When > 0, short ambiguous messages skip the short path so the router
 *   can check for follow-up routing instead.
 * @param hasBlockedAgents — When true, there are agents blocked on wait_for_user.
 *   The user's next message should reach the blocked agent, so we skip ALL
 *   short-path handling except explicit greetings.
 */
export async function tryShortPath(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  activeAgentCount: number = 0,
  hasBlockedAgents: boolean = false
): Promise<ShortPathResult> {
  const raw = request.prompt;
  const normalized = raw.trim().toLowerCase().replace(/[!?.]+$/, "").trim();

  // Skip if there's meaningful conversation history suggesting this is a follow-up
  // to an ongoing task (e.g. "ok" after being asked a question)
  if (request.recentHistory.length > 0) {
    const lastAssistant = [...request.recentHistory]
      .reverse()
      .find(h => h.role === "assistant");
    if (lastAssistant) {
      // If the last assistant message asked a question, don't short-circuit
      if (lastAssistant.content.includes("?")) {
        return { isShortPath: false };
      }
    }
  }

  // If agents are blocked on wait_for_user, skip ALL short-path handling.
  // The user's message is a response to the blocked agent — "yes", "sure", "ok"
  // are likely answers, not generic acknowledgments.
  if (hasBlockedAgents) {
    log.info("Short path: skipping — agents are blocked on wait_for_user", {
      raw: raw.substring(0, 50),
    });
    return { isShortPath: false };
  }

  // Parse agent identity (me.json) for personality-consistent responses
  const identity = parseIdentity(request.agentIdentity);

  // Rule 1: Greetings — always handled (even with active agents)
  if (GREETINGS.has(normalized)) {
    const response = pickGreetingResponse(identity);
    log.info("Short path: greeting", { raw: normalized });
    return { isShortPath: true, response, reason: "greeting" };
  }

  // Rule 2: Acknowledgments — always handled
  if (ACKNOWLEDGMENTS.has(normalized)) {
    log.info("Short path: acknowledgment", { raw: normalized });
    return {
      isShortPath: true,
      response: pickAcknowledgmentResponse(normalized, identity),
      reason: "acknowledgment",
    };
  }

  // Rule 3: Status checks — always handled
  if (STATUS_CHECKS.has(normalized)) {
    log.info("Short path: status check", { raw: normalized });
    return {
      isShortPath: true,
      response: pickStatusResponse(identity),
      reason: "status_check",
    };
  }

  // Rule 4: Farewells — always handled
  if (FAREWELLS.has(normalized)) {
    log.info("Short path: farewell", { raw: normalized });
    return {
      isShortPath: true,
      response: pickFarewellResponse(identity),
      reason: "farewell",
    };
  }

  // Rule 5: Pure emoji (1-3 emoji characters, no text)
  if (/^[\p{Emoji}\s]{1,10}$/u.test(raw.trim()) && raw.trim().length <= 10) {
    log.info("Short path: emoji", { raw: raw.trim() });
    return { isShortPath: true, response: "😊", reason: "emoji" };
  }

  // If there are active/completed agents and this is a short message,
  // skip the short path — let the router check for follow-up routing instead
  if (activeAgentCount > 0 && normalized.split(/\s+/).length < 10) {
    log.info("Short path: skipping — active agents exist, may be follow-up", {
      agentCount: activeAgentCount,
      wordCount: normalized.split(/\s+/).length,
    });
    return { isShortPath: false };
  }

  // Rule 6: Quick memory questions — check if answerable from memory index
  if (options.onPersistMemory && request.memoryIndex?.length) {
    for (const pattern of MEMORY_QUESTION_PATTERNS) {
      if (pattern.test(raw)) {
        const memoryAnswer = await tryMemoryLookup(llm, options, request, identity);
        if (memoryAnswer) {
          log.info("Short path: memory lookup", { raw: raw.substring(0, 50) });
          return { isShortPath: true, response: memoryAnswer, reason: "memory_lookup" };
        }
        break; // Pattern matched but no confident answer — fall through
      }
    }
  }

  // Rule 7: LLM fallback for ambiguous short messages
  // Only for messages under 15 words that don't look like commands/tasks
  if (normalized.split(/\s+/).length <= 12 && !normalized.startsWith("/")) {
    const classified = await classifyWithLLM(llm, options, request, identity);
    if (classified) {
      log.info("Short path: LLM classified as conversational", { raw: raw.substring(0, 50) });
      return { isShortPath: true, response: classified, reason: "conversational" };
    }
  }

  // Not a short-path message — full pipeline needed
  return { isShortPath: false };
}

// ============================================
// IDENTITY PARSING
// ============================================

interface ParsedIdentity {
  name: string;
  role: string;
  traits: string[];
  style: string;
  humanInstructions: string[];
}

function parseIdentity(agentIdentity?: string): ParsedIdentity {
  if (!agentIdentity) {
    return { name: "Dot", role: "", traits: [], style: "", humanInstructions: [] };
  }
  // Parse the compact skeleton format from context-builder (built from me.json)
  const nameMatch = agentIdentity.match(/Name:\s*(.+)/i);
  const roleMatch = agentIdentity.match(/Role:\s*(.+)/i);
  const traitsMatch = agentIdentity.match(/Traits:\s*(.+)/i);
  const styleMatch = agentIdentity.match(/Communication Style:\s*(.+)/i);
  const instructionsMatch = agentIdentity.match(/Human Instructions:\s*(.+)/i);

  return {
    name: nameMatch?.[1]?.trim() || "Dot",
    role: roleMatch?.[1]?.trim() || "",
    traits: traitsMatch?.[1]?.split(/[;,]/).map(t => t.trim()).filter(Boolean) || [],
    style: styleMatch?.[1]?.trim() || "",
    humanInstructions: instructionsMatch?.[1]?.split(/[;]/).map(t => t.trim()).filter(Boolean) || [],
  };
}

// ============================================
// MEMORY LOOKUP
// ============================================

/**
 * Try to answer a question from memory without the full pipeline.
 * Uses a fast LLM call with the memory index to see if there's a confident answer.
 * Responses match the agent's personality from me.json.
 */
async function tryMemoryLookup(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  identity: ParsedIdentity
): Promise<string | null> {
  if (!request.memoryIndex?.length) return null;

  try {
    const { selectedModel: modelConfig, client } = await resolveModelAndClient(
      llm,
      { explicitRole: "intake" }
    );

    const modelSummary = request.memoryIndex
      .map(m => `- ${m.name} (${m.category}): ${m.keywords.join(", ")}`)
      .join("\n");

    const personalityNote = identity.traits.length > 0
      ? `\n\nYou are ${identity.name}. Personality: ${identity.traits.join(", ")}.${identity.style ? ` Style: ${identity.style}.` : ""} Keep your answer natural and in-character.`
      : "";

    const messages: { role: "system" | "user"; content: string }[] = [
      {
        role: "system",
        content: `You have the following knowledge about the user:\n\n${modelSummary}\n\nIf you can confidently answer the question from this knowledge, respond with just the answer (1-2 sentences). If you cannot answer or are unsure, respond with exactly "UNSURE".${personalityNote}`,
      },
      { role: "user", content: request.prompt },
    ];

    const response = await client.chat(messages, {
      model: modelConfig.model,
      maxTokens: 200,
      temperature: 0.1,
    });

    const answer = response.content.trim();
    if (answer === "UNSURE" || answer.includes("UNSURE") || answer.length < 3) {
      return null;
    }
    return answer;
  } catch (error) {
    log.warn("Memory lookup failed (non-fatal)", { error });
    return null;
  }
}

// ============================================
// LLM FALLBACK CLASSIFIER
// ============================================

/**
 * For ambiguous short messages, use a fast LLM call to determine if it's
 * conversational (short path) or task-oriented (full pipeline).
 */
async function classifyWithLLM(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  identity: ParsedIdentity
): Promise<string | null> {
  try {
    const { selectedModel: modelConfig, client } = await resolveModelAndClient(
      llm,
      { explicitRole: "intake" }
    );

    const historyContext = request.recentHistory.length > 0
      ? `Recent conversation:\n${request.recentHistory.slice(-3).map(h => `${h.role}: ${h.content.substring(0, 100)}`).join("\n")}\n\n`
      : "";

    const messages: { role: "system" | "user"; content: string }[] = [
      {
        role: "system",
        content: `You are ${identity.name}. Classify the user's message as either CONVERSATIONAL or TASK.\n\nCONVERSATIONAL: greetings, small talk, emotional sharing, quick questions, personal remarks.\nTASK: requests that need tools, research, code, files, or real work.\n\nIf CONVERSATIONAL, respond naturally as ${identity.name} (${identity.traits.join(", ") || "friendly, direct"}).${identity.style ? ` Style: ${identity.style}` : ""}\nIf TASK, respond with exactly "TASK".`,
      },
      { role: "user", content: `${historyContext}User message: ${request.prompt}` },
    ];

    const response = await client.chat(messages, {
      model: modelConfig.model,
      maxTokens: 200,
      temperature: 0.5,
    });

    const answer = response.content.trim();
    if (answer === "TASK" || answer.startsWith("TASK")) {
      return null;
    }
    // LLM classified as conversational and provided a response
    return answer;
  } catch (error) {
    log.warn("LLM classifier failed (non-fatal)", { error });
    return null;
  }
}

// ============================================
// RESPONSE GENERATORS
// ============================================

/**
 * Response generators use the parsed me.json identity so responses
 * feel like the persona (Dot, or whatever the user named their agent),
 * not like a generic assistant.
 */

function pickGreetingResponse(identity: ParsedIdentity): string {
  // If we have traits, use the first couple to flavor the greeting
  const hasCasualTrait = identity.traits.some(t =>
    /casual|friendly|warm|witty|playful/i.test(t)
  );
  const hasProfessionalTrait = identity.traits.some(t =>
    /professional|formal|serious|direct/i.test(t)
  );

  if (hasProfessionalTrait) {
    const responses = [
      "Hello. What do you need?",
      "Hey. Ready when you are.",
      "What can I do for you?",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  if (hasCasualTrait) {
    const responses = [
      "Hey! What's up?",
      "Yo! What can I help with?",
      "Hey there! What are we working on?",
      "What's going on? Ready when you are.",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  // Default — friendly but neutral
  const responses = [
    "Hey! What can I help you with?",
    "Hi there! What's on your mind?",
    "Hello! Ready when you are — what do you need?",
    "Hey! What are we working on?",
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}

function pickAcknowledgmentResponse(input: string, identity: ParsedIdentity): string {
  const isThankful = ["thanks", "thank you", "thx", "ty", "cheers"].includes(input);
  const isNegative = ["no", "nope", "nah"].includes(input);
  const hasCasualTrait = identity.traits.some(t =>
    /casual|friendly|warm|witty|playful/i.test(t)
  );

  if (isThankful) {
    if (hasCasualTrait) {
      const responses = ["Anytime!", "No worries! What's next?", "Happy to help!"];
      return responses[Math.floor(Math.random() * responses.length)];
    }
    const responses = [
      "You're welcome. Let me know if you need anything else.",
      "Happy to help. Anything else?",
      "Anytime. What's next?",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  if (isNegative) {
    return "Alright. Let me know when you need something.";
  }

  return "Got it. Let me know when you need something.";
}

function pickStatusResponse(identity: ParsedIdentity): string {
  const hasCasualTrait = identity.traits.some(t =>
    /casual|friendly|warm|witty|playful/i.test(t)
  );

  if (hasCasualTrait) {
    const responses = [
      "Yep, I'm here! What's up?",
      "Right here! What do you need?",
      "I'm around. What's going on?",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  const responses = [
    "I'm here. What do you need?",
    "Online and ready. What can I do for you?",
    "Here. What's up?",
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}

function pickFarewellResponse(identity: ParsedIdentity): string {
  const hasCasualTrait = identity.traits.some(t =>
    /casual|friendly|warm|witty|playful/i.test(t)
  );

  if (hasCasualTrait) {
    const responses = [
      "Later! I'll be here when you need me.",
      "See ya! Just holler when you need something.",
      "Catch you later! I'll keep things running.",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  const responses = [
    "See you later. I'll be here when you need me.",
    "Take care. Message when you need anything.",
    "Later. I'll keep things running.",
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}
