/**
 * Device Bridge
 * 
 * Request/response pairs for communicating with the local agent.
 * Each function sends a typed request and waits for the matching result.
 * 
 * Covers: execution commands, memory, skills, personas, councils, knowledge.
 */

import { nanoid } from "nanoid";
import type { ExecutionCommand } from "../types.js";
import { createComponentLogger } from "../logging.js";
import { devices, sendMessage, type MemoryRequest, type SkillRequest } from "./devices.js";

const log = createComponentLogger("ws.bridge");

// ============================================
// EXECUTION COMMANDS
// ============================================

export async function sendExecutionCommand(
  deviceId: string,
  command: ExecutionCommand
): Promise<string> {
  const device = devices.get(deviceId);
  if (!device) {
    throw new Error("Device not connected");
  }

  log.info(`Sending execution command to ${device.session.deviceName}`, {
    commandId: command.id,
    type: command.type,
    path: command.payload.path,
  });

  return new Promise((resolve, reject) => {
    device.pendingCommands.set(command.id, {
      command,
      resolve: (result) => {
        if (result.success) {
          resolve(result.output);
        } else {
          const errMsg = typeof result.error === "string" ? result.error
            : result.error ? JSON.stringify(result.error)
            : `Execution failed: ${result.output}`;
          reject(new Error(errMsg));
        }
      },
      reject
    });

    sendMessage(device.ws, {
      type: "execution_request",
      id: nanoid(),
      timestamp: Date.now(),
      payload: command
    });

    // Timeout after command timeout + buffer
    setTimeout(() => {
      const pending = device.pendingCommands.get(command.id);
      if (pending) {
        device.pendingCommands.delete(command.id);
        reject(new Error("Execution timeout"));
      }
    }, command.timeout + 5000);
  });
}

export function handleExecutionResult(deviceId: string, result: any): void {
  const device = devices.get(deviceId);
  if (!device) return;

  log.info(`Execution result from ${device.session.deviceName}`, {
    commandId: result.commandId,
    success: result.success,
    outputLength: result.output?.length || 0,
    error: result.error,
  });

  const pending = device.pendingCommands.get(result.commandId);
  if (pending) {
    pending.resolve(result);
    device.pendingCommands.delete(result.commandId);
  } else {
    log.warn(`No pending command found for ${result.commandId} on device ${deviceId}`);
  }
}

// ============================================
// MEMORY REQUESTS
// ============================================

export async function sendMemoryRequest(deviceId: string, request: MemoryRequest, timeoutMs: number = 30_000): Promise<any> {
  const device = devices.get(deviceId);
  if (!device) {
    throw new Error("Device not connected");
  }

  if (!device.session.capabilities.includes("memory")) {
    throw new Error("Device does not support memory operations");
  }

  const requestId = nanoid();

  return new Promise((resolve, reject) => {
    device.pendingMemoryRequests.set(requestId, { resolve, reject });

    sendMessage(device.ws, {
      type: "memory_request",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        ...request,
        requestId
      }
    });

    setTimeout(() => {
      const pending = device.pendingMemoryRequests.get(requestId);
      if (pending) {
        device.pendingMemoryRequests.delete(requestId);
        reject(new Error("Memory request timeout"));
      }
    }, timeoutMs);
  });
}

export function handleMemoryResult(deviceId: string, result: { requestId: string; success: boolean; data?: any; error?: string }): void {
  const device = devices.get(deviceId);
  if (!device) return;

  const pending = device.pendingMemoryRequests.get(result.requestId);
  if (pending) {
    if (result.success) {
      pending.resolve(result.data);
    } else {
      pending.reject(new Error(result.error || "Memory request failed"));
    }
    device.pendingMemoryRequests.delete(result.requestId);
  }
}

// ============================================
// SKILL REQUESTS
// ============================================

export async function sendSkillRequest(deviceId: string, request: SkillRequest): Promise<any> {
  const device = devices.get(deviceId);
  if (!device) {
    throw new Error("Device not connected");
  }

  if (!device.session.capabilities.includes("skills")) {
    throw new Error("Device does not support skill operations");
  }

  const requestId = nanoid();

  return new Promise((resolve, reject) => {
    device.pendingSkillRequests.set(requestId, { resolve, reject });

    sendMessage(device.ws, {
      type: "skill_request",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        ...request,
        requestId
      }
    });

    setTimeout(() => {
      const pending = device.pendingSkillRequests.get(requestId);
      if (pending) {
        device.pendingSkillRequests.delete(requestId);
        reject(new Error("Skill request timeout"));
      }
    }, 30000);
  });
}

export function handleSkillResult(deviceId: string, result: { requestId: string; success: boolean; data?: any; error?: string }): void {
  const device = devices.get(deviceId);
  if (!device) return;

  const pending = device.pendingSkillRequests.get(result.requestId);
  if (pending) {
    if (result.success) {
      pending.resolve(result.data);
    } else {
      pending.reject(new Error(result.error || "Skill request failed"));
    }
    device.pendingSkillRequests.delete(result.requestId);
  }
}

// ============================================
// PERSONA REQUESTS
// ============================================

export function handlePersonaResult(deviceId: string, payload: any): void {
  const device = devices.get(deviceId);
  if (!device) return;

  const pending = device.pendingPersonaRequests.get(payload.requestId);
  if (pending) {
    device.pendingPersonaRequests.delete(payload.requestId);
    if (payload.success) {
      pending.resolve(payload.data);
    } else {
      pending.reject(new Error(payload.error || "Persona request failed"));
    }
  }
}

export async function requestPersonas(deviceId: string): Promise<any[]> {
  const device = devices.get(deviceId);
  if (!device) {
    throw new Error("Device not connected");
  }

  const requestId = nanoid();

  return new Promise((resolve, reject) => {
    device.pendingPersonaRequests.set(requestId, { resolve, reject });

    sendMessage(device.ws, {
      type: "persona_request",
      id: requestId,
      timestamp: Date.now(),
      payload: { action: "list" }
    });

    setTimeout(() => {
      const pending = device.pendingPersonaRequests.get(requestId);
      if (pending) {
        device.pendingPersonaRequests.delete(requestId);
        reject(new Error("Persona request timeout"));
      }
    }, 30000);
  });
}

// ============================================
// COUNCIL REQUESTS
// ============================================

export function handleCouncilResult(deviceId: string, payload: any): void {
  const device = devices.get(deviceId);
  if (!device) return;

  const pending = device.pendingCouncilRequests.get(payload.requestId);
  if (pending) {
    device.pendingCouncilRequests.delete(payload.requestId);
    if (payload.success) {
      pending.resolve(payload.data);
    } else {
      pending.reject(new Error(payload.error || "Council request failed"));
    }
  }
}

export async function requestCouncilPaths(deviceId: string): Promise<any[]> {
  const device = devices.get(deviceId);
  if (!device) {
    throw new Error("Device not connected");
  }

  const requestId = nanoid();

  return new Promise((resolve, reject) => {
    device.pendingCouncilRequests.set(requestId, { resolve, reject });

    sendMessage(device.ws, {
      type: "council_request",
      id: requestId,
      timestamp: Date.now(),
      payload: { action: "list" }
    });

    setTimeout(() => {
      const pending = device.pendingCouncilRequests.get(requestId);
      if (pending) {
        device.pendingCouncilRequests.delete(requestId);
        reject(new Error("Council request timeout"));
      }
    }, 30000);
  });
}

// ============================================
// KNOWLEDGE REQUESTS
// ============================================

export function handleKnowledgeResult(deviceId: string, payload: any): void {
  const device = devices.get(deviceId);
  if (!device) return;

  const pending = device.pendingKnowledgeRequests.get(payload.requestId);
  if (pending) {
    device.pendingKnowledgeRequests.delete(payload.requestId);
    if (payload.success) {
      pending.resolve(payload.documents || []);
    } else {
      pending.reject(new Error(payload.error || "Knowledge request failed"));
    }
  }
}

export async function requestKnowledge(deviceId: string, personaSlug: string): Promise<any[]> {
  const device = devices.get(deviceId);
  if (!device) {
    throw new Error("Device not connected");
  }

  const requestId = nanoid();

  return new Promise((resolve, reject) => {
    device.pendingKnowledgeRequests.set(requestId, { resolve, reject });

    sendMessage(device.ws, {
      type: "knowledge_request",
      id: requestId,
      timestamp: Date.now(),
      payload: { 
        personaSlug,
        requestId
      }
    });

    setTimeout(() => {
      const pending = device.pendingKnowledgeRequests.get(requestId);
      if (pending) {
        device.pendingKnowledgeRequests.delete(requestId);
        reject(new Error("Knowledge request timeout"));
      }
    }, 30000);
  });
}

// ============================================
// KNOWLEDGE QUERY (pre-scored by local agent)
// ============================================

export function handleKnowledgeQueryResult(deviceId: string, payload: any): void {
  const device = devices.get(deviceId);
  if (!device) return;

  const pending = device.pendingKnowledgeRequests.get(payload.requestId);
  if (pending) {
    device.pendingKnowledgeRequests.delete(payload.requestId);
    if (payload.success) {
      pending.resolve({
        results: payload.results || [],
        documentsSearched: payload.documentsSearched || 0,
      });
    } else {
      pending.reject(new Error(payload.error || "Knowledge query failed"));
    }
  }
}

export interface KnowledgeQueryOptions {
  personaSlug: string;
  query: string;
  maxResults?: number;
  maxCharacters?: number;
}

export async function requestKnowledgeQuery(
  deviceId: string,
  options: KnowledgeQueryOptions
): Promise<{ results: any[]; documentsSearched: number }> {
  const device = devices.get(deviceId);
  if (!device) {
    throw new Error("Device not connected");
  }

  const requestId = nanoid();

  return new Promise((resolve, reject) => {
    device.pendingKnowledgeRequests.set(requestId, { resolve, reject });

    sendMessage(device.ws, {
      type: "knowledge_query",
      id: requestId,
      timestamp: Date.now(),
      payload: {
        ...options,
        requestId,
      }
    });

    setTimeout(() => {
      const pending = device.pendingKnowledgeRequests.get(requestId);
      if (pending) {
        device.pendingKnowledgeRequests.delete(requestId);
        reject(new Error("Knowledge query timeout"));
      }
    }, 30000);
  });
}

// ============================================
// TOOL REQUESTS
// ============================================

export interface ToolManifestResponse {
  tools: any[];
  runtimes: any[];
}

export function handleToolResult(deviceId: string, payload: any): void {
  const device = devices.get(deviceId);
  if (!device) return;

  const pending = device.pendingToolRequests.get(payload.requestId);
  if (pending) {
    device.pendingToolRequests.delete(payload.requestId);
    if (payload.success) {
      pending.resolve({ tools: payload.data, runtimes: payload.runtimes || [] });
    } else {
      pending.reject(new Error(payload.error || "Tool request failed"));
    }
  }
}

export async function requestTools(deviceId: string): Promise<ToolManifestResponse> {
  const device = devices.get(deviceId);
  if (!device) {
    throw new Error("Device not connected");
  }

  const requestId = nanoid();

  return new Promise((resolve, reject) => {
    device.pendingToolRequests.set(requestId, { resolve, reject });

    sendMessage(device.ws, {
      type: "tool_request",
      id: requestId,
      timestamp: Date.now(),
      payload: { action: "manifest" }
    });

    setTimeout(() => {
      const pending = device.pendingToolRequests.get(requestId);
      if (pending) {
        device.pendingToolRequests.delete(requestId);
        reject(new Error("Tool request timeout"));
      }
    }, 30000);
  });
}

// ============================================
// SCHEMA RESULTS
// ============================================

export function handleSchemaResult(deviceId: string, result: any): void {
  log.debug(`Schema received for ${result.path}`, { type: result.type });
}
