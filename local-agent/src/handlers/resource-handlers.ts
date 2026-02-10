/**
 * Resource Handlers
 * 
 * Handles execution, schema, thread, and asset requests from the server.
 */

import { nanoid } from "nanoid";
import type { WSMessage, ExecutionCommand } from "../types.js";
import { executeCommand } from "../executor.js";
import { extractSchema } from "../schema.js";
import * as memory from "../memory/index.js";

type SendFn = (message: WSMessage) => void;

// ============================================
// EXECUTION
// ============================================

export async function handleExecutionRequest(command: ExecutionCommand, send: SendFn): Promise<void> {
  console.log(`[Agent] Executing ${command.type}: ${command.dryRun ? "(DRY RUN)" : ""}`);
  
  try {
    const result = await executeCommand(command);
    
    send({
      type: "execution_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: result
    });
  } catch (error) {
    send({
      type: "execution_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        commandId: command.id,
        success: false,
        output: "",
        error: error instanceof Error ? error.message : "Unknown error",
        exitCode: -1
      }
    });
  }
}

// ============================================
// SCHEMA
// ============================================

export async function handleSchemaRequest(payload: { path: string; commandId: string }, send: SendFn): Promise<void> {
  console.log(`[Agent] Extracting schema: ${payload.path}`);
  
  try {
    const schema = await extractSchema(payload.path);
    
    send({
      type: "schema_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: schema
    });
  } catch (error) {
    console.error("[Agent] Schema extraction failed:", error);
  }
}

// ============================================
// THREADS
// ============================================

export async function handleThreadRequest(message: WSMessage, send: SendFn): Promise<void> {
  const { level, threadIds, councilId } = message.payload;
  console.log(`[Agent] Thread request L${level}: ${threadIds?.join(", ") || "none"}`);
  
  try {
    const result: any = {
      summaries: [],
      packets: [],
      personas: []
    };
    
    if (level === 1) {
      for (const threadId of threadIds || []) {
        const thread = await memory.getThread(threadId);
        if (thread) {
          result.summaries.push({
            id: thread.id,
            topic: thread.topic,
            keywords: thread.keywords || [],
            lastMessage: thread.messages?.[thread.messages.length - 1]?.content?.substring(0, 100) || "",
            openLoopCount: thread.openLoops?.length || 0,
            beliefCount: thread.beliefs?.length || 0
          });
        }
      }
    } else if (level === 2) {
      for (const threadId of threadIds || []) {
        const thread = await memory.getThread(threadId);
        if (thread) {
          result.packets.push(thread);
        }
      }
      
      if (councilId) {
        const council = await memory.loadCouncilPath(councilId);
        if (council?.personas) {
          for (const personaId of council.personas) {
            const persona = await memory.loadPersona(personaId);
            if (persona) {
              result.personas.push(persona);
            }
          }
        }
      }
    }
    
    send({
      type: "thread_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        level,
        ...result
      }
    });
  } catch (error) {
    console.error(`[Agent] Thread request failed:`, error);
    send({
      type: "thread_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        level,
        summaries: [],
        packets: [],
        personas: []
      }
    });
  }
}

export async function handleThreadUpdate(message: WSMessage): Promise<void> {
  const { threadId, updates } = message.payload;
  console.log(`[Agent] Thread update: ${threadId}`);
  
  try {
    await memory.updateThread(threadId, updates);
    console.log(`[Agent] Thread ${threadId} updated`);
  } catch (error) {
    console.error(`[Agent] Thread update failed:`, error);
  }
}

export async function handleSaveToThread(message: WSMessage): Promise<void> {
  const { threadId, createIfMissing, newThreadTopic, entry } = message.payload;
  console.log(`[Agent] Save to thread: ${threadId}`);
  
  try {
    await memory.saveToThread(threadId, entry, { createIfMissing, topic: newThreadTopic });
    console.log(`[Agent] Saved to thread ${threadId}`);
  } catch (error) {
    console.error(`[Agent] Save to thread failed:`, error);
  }
}

// ============================================
// ASSETS
// ============================================

export async function handleStoreAsset(message: WSMessage, send: SendFn): Promise<void> {
  const { taskId, sessionId, asset } = message.payload;
  console.log(`[Agent] Store asset: ${asset.filename}`);
  
  try {
    const clientPath = await memory.storeAsset(sessionId, taskId, asset);
    
    send({
      type: "asset_stored",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        taskId,
        assetId: `asset_${nanoid(12)}`,
        clientPath
      }
    });
  } catch (error) {
    console.error(`[Agent] Store asset failed:`, error);
  }
}

export async function handleRetrieveAsset(message: WSMessage, send: SendFn): Promise<void> {
  const { assetId, clientPath } = message.payload;
  console.log(`[Agent] Retrieve asset: ${clientPath}`);
  
  try {
    const data = await memory.retrieveAsset(clientPath);
    
    send({
      type: "asset_data",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        assetId,
        data
      }
    });
  } catch (error) {
    console.error(`[Agent] Retrieve asset failed:`, error);
  }
}

export async function handleCleanupAssets(message: WSMessage): Promise<void> {
  const { sessionId, taskIds } = message.payload;
  console.log(`[Agent] Cleanup assets: ${sessionId || taskIds?.join(", ")}`);
  
  try {
    await memory.cleanupAssets(sessionId, taskIds);
    console.log(`[Agent] Assets cleaned up`);
  } catch (error) {
    console.error(`[Agent] Cleanup assets failed:`, error);
  }
}
