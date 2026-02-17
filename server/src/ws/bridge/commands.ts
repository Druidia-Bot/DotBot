/**
 * Bridge Commands — Request/Response Senders
 *
 * Each function sends a typed request to the local agent and waits
 * for the matching result via a Promise stored in the device's
 * pending request Map.
 *
 * Covers: execution, memory, skills, personas, councils, knowledge, tools.
 */

import { nanoid } from "nanoid";
import type { ExecutionCommand } from "../../types.js";
import { createComponentLogger } from "#logging.js";
import { devices, sendMessage, type MemoryRequest, type SkillRequest } from "../devices.js";

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

// ============================================
// PERSONA REQUESTS
// ============================================

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
