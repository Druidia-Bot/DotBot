/**
 * Bridge Results — Incoming Result Handlers
 *
 * Called by the message router when the local agent sends back
 * a result for a pending request. Each handler resolves or rejects
 * the matching Promise in the device's pending Map.
 */

import { createComponentLogger } from "#logging.js";
import { devices } from "../devices.js";

const log = createComponentLogger("ws.bridge");

// ============================================
// EXECUTION RESULTS
// ============================================

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
// MEMORY RESULTS
// ============================================

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
// SKILL RESULTS
// ============================================

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
// PERSONA RESULTS
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

// ============================================
// COUNCIL RESULTS
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

// ============================================
// KNOWLEDGE RESULTS
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

// ============================================
// TOOL RESULTS
// ============================================

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

// ============================================
// SCHEMA RESULTS
// ============================================

export function handleSchemaResult(deviceId: string, result: any): void {
  log.debug(`Schema received for ${result.path}`, { type: result.type });
}
