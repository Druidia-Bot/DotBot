/**
 * Council Orchestrator
 *
 * Multi-persona council discussions with contribute and consensus modes.
 * Enables multiple personas to collaborate on complex decisions.
 *
 * Flow:
 * 1. Load council configuration and resolve personas
 * 2. Run discussion rounds (1 round for contribute, up to N for consensus)
 * 3. Check for consensus after each round (consensus mode only)
 * 4. Synthesize final response from all perspectives
 */

import { createComponentLogger } from "../logging.js";
import { resolveModelAndClient } from "./execution.js";
import type { ILLMClient } from "../llm/types.js";
import type { AgentRunnerOptions } from "./runner-types.js";
import type {
  CouncilDefinition,
  ResolvedCouncil,
  LocalPersonaDefinition,
  PersonaDefinition,
} from "../types/agent.js";

const log = createComponentLogger("council");

// ============================================
// TYPES
// ============================================

export interface CouncilTurn {
  round: number;
  personaId: string;
  personaName: string;
  message: string;
  model: string;
  provider: string;
  timestamp: number;
}

export interface CouncilResult {
  finalResponse: string;
  turns: CouncilTurn[];
  rounds: number;
  consensusReached: boolean;
  participants: string[];
}

// ============================================
// MAIN ORCHESTRATOR
// ============================================

/**
 * Council streaming callback — called when each persona speaks
 */
export type CouncilStreamCallback = (turn: {
  type: "council_turn" | "council_consensus" | "council_synthesis";
  data: any;
}) => void;

/**
 * Run a council discussion on a topic or task result.
 *
 * Contribute mode: Each persona gives one opinion, done.
 * Consensus mode: Loop until all agree (or max rounds hit).
 *
 * @param onStream Optional callback for real-time council turn streaming
 */
export async function runCouncilDiscussion(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  council: ResolvedCouncil,
  originalPrompt: string,
  baseOutput: string,
  onStream?: CouncilStreamCallback
): Promise<CouncilResult> {
  const personas = council.personas;

  if (personas.length === 0) {
    throw new Error(`Council "${council.id}" has no valid personas`);
  }

  log.info(`Starting council discussion`, {
    councilId: council.id,
    councilName: council.name,
    personaCount: personas.length,
    reviewMode: council.reviewMode,
    rounds: council.protocol.rounds,
  });

  const turns: CouncilTurn[] = [];
  const maxRounds = council.protocol.rounds;
  let round = 1;
  let consensusReached = false;

  // Initial context for all personas
  const baseContext = `## Council: ${council.name}

${council.description}

## Topic

User request: "${originalPrompt}"

## Base Work Completed

${baseOutput}

---

As a member of this council, provide your perspective on the above work.`;

  // REVIEW MODE: Council just reviews/polishes existing output (single round)
  if (council.reviewMode) {
    log.info("Council in REVIEW mode - single round only");

    for (let i = 0; i < personas.length; i++) {
      const persona = personas[i];
      const turn = await getPersonaOpinion(
        llm,
        options,
        persona,
        baseContext,
        turns,
        round,
        false // not checking consensus in review mode
      );
      turns.push(turn);

      // Stream turn in real-time
      if (onStream) {
        onStream({
          type: "council_turn",
          data: {
            type: "council_turn",
            councilId: council.id,
            councilName: council.name,
            round,
            maxRounds: 1,
            personaId: turn.personaId,
            personaName: turn.personaName,
            message: turn.message,
            model: turn.model,
            provider: turn.provider,
            timestamp: turn.timestamp,
            totalPersonas: personas.length,
            personaIndex: i + 1,
          },
        });
      }
    }

    // Synthesize final response
    if (onStream) {
      onStream({
        type: "council_synthesis",
        data: { type: "council_synthesis", councilId: council.id, status: "started" },
      });
    }

    const finalResponse = await synthesizeCouncilResponse(
      llm,
      options,
      council,
      personas,
      turns
    );

    if (onStream) {
      onStream({
        type: "council_synthesis",
        data: { type: "council_synthesis", councilId: council.id, status: "completed" },
      });
    }

    return {
      finalResponse,
      turns,
      rounds: 1,
      consensusReached: true, // review mode doesn't need consensus
      participants: personas.map((p) => p.name),
    };
  }

  // CONSENSUS MODE: Loop until agreement or max rounds
  while (round <= maxRounds && !consensusReached) {
    log.info(`Council round ${round}/${maxRounds}`);

    // Each persona speaks
    for (let i = 0; i < personas.length; i++) {
      const persona = personas[i];
      const turn = await getPersonaOpinion(
        llm,
        options,
        persona,
        baseContext,
        turns,
        round,
        round > 1 // check consensus from round 2 onwards
      );
      turns.push(turn);

      // Stream turn in real-time
      if (onStream) {
        onStream({
          type: "council_turn",
          data: {
            type: "council_turn",
            councilId: council.id,
            councilName: council.name,
            round,
            maxRounds,
            personaId: turn.personaId,
            personaName: turn.personaName,
            message: turn.message,
            model: turn.model,
            provider: turn.provider,
            timestamp: turn.timestamp,
            totalPersonas: personas.length,
            personaIndex: i + 1,
          },
        });
      }
    }

    // Check for consensus after round completes
    if (round > 1 || council.protocol.judgeAfterEachRound) {
      consensusReached = await checkConsensus(
        llm,
        options,
        council,
        personas,
        turns,
        onStream
      );

      if (consensusReached) {
        log.info(`Consensus reached after round ${round}`);
        break;
      }

      if (!consensusReached && round < maxRounds) {
        // Prompt for refinement
        const refinementTurn: CouncilTurn = {
          round: round + 1,
          personaId: "moderator",
          personaName: "Moderator",
          message:
            "Consensus not yet reached. Let's refine the approach based on the points raised. Please focus on resolving the key disagreements.",
          model: "system",
          provider: "system",
          timestamp: Date.now(),
        };
        turns.push(refinementTurn);
        log.info(`No consensus yet, moving to round ${round + 1}`);

        // Stream moderator message
        if (onStream) {
          onStream({
            type: "council_turn",
            data: {
              type: "council_turn",
              councilId: council.id,
              councilName: council.name,
              round: round + 1,
              maxRounds,
              personaId: "moderator",
              personaName: "Moderator",
              message: refinementTurn.message,
              model: "system",
              provider: "system",
              timestamp: refinementTurn.timestamp,
              totalPersonas: personas.length,
              personaIndex: 0, // Moderator is not counted
            },
          });
        }
      }
    }

    round++;
  }

  // Synthesize final response (even if consensus wasn't reached)
  log.info(`Council discussion complete`, {
    rounds: round - 1,
    consensusReached,
    turnCount: turns.length,
  });

  // Stream synthesis start
  if (onStream) {
    onStream({
      type: "council_synthesis",
      data: { type: "council_synthesis", councilId: council.id, status: "started" },
    });
  }

  const finalResponse = await synthesizeCouncilResponse(
    llm,
    options,
    council,
    personas,
    turns
  );

  // Stream synthesis complete
  if (onStream) {
    onStream({
      type: "council_synthesis",
      data: { type: "council_synthesis", councilId: council.id, status: "completed" },
    });
  }

  return {
    finalResponse,
    turns,
    rounds: round - 1,
    consensusReached,
    participants: personas.map((p) => p.name),
  };
}

// ============================================
// PERSONA OPINION GATHERING
// ============================================

async function getPersonaOpinion(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  persona: PersonaDefinition,
  baseContext: string,
  previousTurns: CouncilTurn[],
  round: number,
  checkingConsensus: boolean
): Promise<CouncilTurn> {
  // Select model for this persona (support both LocalPersonaDefinition and PersonaDefinition)
  const isLocalPersona = persona.type === "client" && "slug" in persona;
  const { selectedModel, client } = await resolveModelAndClient(llm, {
    personaModelTier: persona.modelTier,
    explicitRole: persona.modelRole,
    // Use personaModelOverride if this is a local persona with specific preferences
    ...(isLocalPersona && {
      personaModelOverride: {
        tier: persona.modelTier,
      },
    }),
  });

  // Build conversation history
  const conversationHistory =
    previousTurns.length > 0
      ? "\n## Council Discussion So Far\n\n" +
        previousTurns
          .filter((t) => t.personaId !== "moderator")
          .map((t) => `**${t.personaName}** (Round ${t.round}):\n${t.message}`)
          .join("\n\n")
      : "";

  const systemPrompt = `${persona.systemPrompt}

## Council Role

You are participating in a council discussion as ${persona.name}. Other experts are also contributing.

${
  checkingConsensus
    ? "This is a consensus-building discussion. Your goal is to work toward agreement while staying true to your principles. If you see issues, raise them. If previous suggestions align with your view, acknowledge it and build on them."
    : "Share your perspective on this topic. You don't need to agree with others - provide YOUR unique viewpoint."
}

Keep your response focused (2-3 paragraphs). Reference specific points from others if building on or disagreeing with them.`;

  const userMessage = `${baseContext}${conversationHistory}

---

Provide your perspective as ${persona.name}. ${round > 1 ? "Consider the points raised by other council members." : ""}`;

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userMessage },
  ];

  options.onLLMRequest?.({
    persona: persona.id,
    provider: selectedModel.provider,
    model: selectedModel.model,
    promptLength: systemPrompt.length + userMessage.length,
    maxTokens: selectedModel.maxTokens,
    messages,
  });

  const startTime = Date.now();
  const response = await client.chat(messages, {
    model: selectedModel.model,
    maxTokens: selectedModel.maxTokens,
    temperature: selectedModel.temperature,
  });

  options.onLLMResponse?.({
    persona: persona.id,
    duration: Date.now() - startTime,
    responseLength: response.content.length,
    response: response.content,
    model: response.model,
    provider: response.provider,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  });

  return {
    round,
    personaId: persona.id,
    personaName: persona.name,
    message: response.content,
    model: response.model,
    provider: response.provider,
    timestamp: Date.now(),
  };
}

// ============================================
// CONSENSUS CHECKING
// ============================================

async function checkConsensus(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  council: ResolvedCouncil,
  personas: PersonaDefinition[],
  turns: CouncilTurn[],
  onStream?: CouncilStreamCallback
): Promise<boolean> {
  // Use a fast model for consensus checking
  const { selectedModel, client } = await resolveModelAndClient(llm, {
    explicitRole: "intake",
  });

  const recentTurns = turns.slice(-personas.length); // last round only
  const conversationSummary = recentTurns
    .filter((t) => t.personaId !== "moderator")
    .map((t) => `**${t.personaName}**: ${t.message}`)
    .join("\n\n");

  const systemPrompt = `You are a moderator for a council discussion. Review the most recent round of opinions and determine if consensus has been reached.

Consensus means:
- No major unresolved disagreements
- All personas have acknowledged the key points
- A coherent direction or recommendation has emerged
- It's clear what the council's collective advice is

Respond with JSON: { "consensus": true/false, "reasoning": "why" }`;

  const userMessage = `## Council: ${council.name}

${council.description}

## Latest Round

${conversationSummary}

Has consensus been reached?`;

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userMessage },
  ];

  try {
    const response = await client.chat(messages, {
      model: selectedModel.model,
      maxTokens: 500,
      temperature: 0.0,
      responseFormat: "json_object",
    });

    const parsed = JSON.parse(response.content);
    log.info(`Consensus check result`, {
      consensus: parsed.consensus,
      reasoning: parsed.reasoning,
    });

    // Stream consensus check result
    if (onStream) {
      onStream({
        type: "council_consensus",
        data: {
          type: "council_consensus",
          councilId: council.id,
          round: turns[turns.length - 1]?.round || 1,
          consensusReached: parsed.consensus === true,
          reasoning: parsed.reasoning || "",
        },
      });
    }

    return parsed.consensus === true;
  } catch (e) {
    log.warn(`Consensus check failed, assuming no consensus`, { error: e });

    // Stream failure
    if (onStream) {
      onStream({
        type: "council_consensus",
        data: {
          type: "council_consensus",
          councilId: council.id,
          round: turns[turns.length - 1]?.round || 1,
          consensusReached: false,
          reasoning: "Consensus check failed",
        },
      });
    }

    return false; // If parsing fails, assume no consensus
  }
}

// ============================================
// SYNTHESIS
// ============================================

async function synthesizeCouncilResponse(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  council: ResolvedCouncil,
  personas: PersonaDefinition[],
  turns: CouncilTurn[]
): Promise<string> {
  // Use smart model for synthesis
  const { selectedModel, client } = await resolveModelAndClient(llm, {
    personaModelTier: "smart",
  });

  const fullDiscussion = turns
    .filter((t) => t.personaId !== "moderator")
    .map((t) => `**${t.personaName}** (Round ${t.round}):\n${t.message}`)
    .join("\n\n");

  const systemPrompt = `You are synthesizing a council discussion into a final response for the user.

The council "${council.name}" has discussed a topic. Your job is to:
1. Summarize the key insights and recommendations from each member
2. Highlight areas of agreement and disagreement
3. Provide a clear, actionable summary of the council's collective advice

Do NOT introduce new ideas. Only synthesize what the council members actually said.`;

  const userMessage = `## Council Discussion

${fullDiscussion}

---

Synthesize this into a clear final response for the user. Start with "The ${council.name} has reviewed..." and make it feel like a cohesive team response.`;

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userMessage },
  ];

  options.onLLMRequest?.({
    persona: "council-synthesizer",
    provider: selectedModel.provider,
    model: selectedModel.model,
    promptLength: systemPrompt.length + userMessage.length,
    maxTokens: selectedModel.maxTokens,
    messages,
  });

  const startTime = Date.now();
  const response = await client.chat(messages, {
    model: selectedModel.model,
    maxTokens: 2048,
    temperature: 0.3,
  });

  options.onLLMResponse?.({
    persona: "council-synthesizer",
    duration: Date.now() - startTime,
    responseLength: response.content.length,
    response: response.content,
    model: response.model,
    provider: response.provider,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  });

  return response.content;
}
