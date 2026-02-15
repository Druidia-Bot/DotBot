/**
 * Memory & Skill Request Handlers
 * 
 * Handles all memory_request and skill_request messages from the server.
 */

import { nanoid } from "nanoid";
import type { WSMessage, MemoryRequest, SkillRequest } from "../types.js";
import * as memory from "../memory/index.js";

type SendFn = (message: WSMessage) => void;

// ============================================
// MEMORY REQUESTS
// ============================================

export async function handleMemoryRequest(request: MemoryRequest, send: SendFn): Promise<void> {
  console.log(`[Agent] Memory ${request.action}: ${request.modelSlug || request.category || request.query || ""}`);
  
  try {
    let result: any;
    
    switch (request.action) {
      case "get_index":
        result = await memory.getMemoryIndex();
        break;
        
      case "get_model":
        result = request.modelSlug ? await memory.getMentalModel(request.modelSlug) : null;
        break;
        
      case "create_model":
        if (request.data) {
          result = await memory.createMentalModel(
            request.data.name,
            request.data.category,
            request.data.description
          );
        }
        break;
        
      case "add_belief":
        if (request.modelSlug && request.data) {
          result = await memory.addBelief(
            request.modelSlug,
            request.data.attribute,
            request.data.value,
            request.data.evidence,
            request.data.confidence
          );
        }
        break;
        
      case "add_open_loop":
        if (request.modelSlug && request.data) {
          result = await memory.addOpenLoop(
            request.modelSlug,
            request.data.description,
            request.data.importance,
            request.data.resolutionCriteria
          );
        }
        break;
        
      case "resolve_open_loop":
        if (request.modelSlug && request.data) {
          result = await memory.resolveOpenLoop(
            request.modelSlug,
            request.data.loopId,
            request.data.resolution
          );
        }
        break;
        
      case "add_question":
        if (request.modelSlug && request.data) {
          result = await memory.addQuestion(
            request.modelSlug,
            request.data.question,
            request.data.purpose,
            request.data.priority,
            request.data.informs
          );
        }
        break;
        
      case "add_constraint":
        if (request.modelSlug && request.data) {
          result = await memory.addConstraint(
            request.modelSlug,
            request.data.description,
            request.data.type,
            request.data.source,
            request.data.flexibility,
            request.data.expiresAt
          );
        }
        break;
        
      case "save_model":
        if (request.data) {
          const slug = request.data.slug || request.modelSlug;
          if (slug) {
            const existing = await memory.getMentalModel(slug);
            if (existing) {
              // Merge new beliefs into existing model
              if (request.data.beliefs) {
                for (const belief of request.data.beliefs) {
                  const existingBelief = existing.beliefs.findIndex(
                    (b: any) => b.attribute === belief.attribute
                  );
                  if (existingBelief >= 0) {
                    existing.beliefs[existingBelief].value = belief.value;
                    existing.beliefs[existingBelief].confidence = belief.confidence || existing.beliefs[existingBelief].confidence;
                    existing.beliefs[existingBelief].lastConfirmedAt = new Date().toISOString();
                  } else {
                    existing.beliefs.push(belief);
                  }
                }
              }
              if (request.data.openLoops) {
                for (const loop of request.data.openLoops) {
                  if (!existing.openLoops.some((l: any) => l.description === loop.description)) {
                    existing.openLoops.push(loop);
                  }
                }
              }
              if (request.data.constraints) {
                for (const c of request.data.constraints) {
                  if (!existing.constraints.some((ec: any) => ec.description === c.description)) {
                    existing.constraints.push(c);
                  }
                }
              }
              if (request.data.conversations) {
                existing.conversations.push(...request.data.conversations);
                if (existing.conversations.length > 50) {
                  existing.conversations = existing.conversations.slice(-50);
                }
              }
              if (request.data.agents) {
                existing.agents = existing.agents || [];
                for (const agent of request.data.agents) {
                  const idx = existing.agents.findIndex((a: any) => a.agentId === agent.agentId);
                  if (idx >= 0) {
                    existing.agents[idx] = { ...existing.agents[idx], ...agent, updatedAt: agent.updatedAt || new Date().toISOString() };
                  } else {
                    existing.agents.push(agent);
                  }
                }
              }
              await memory.saveMentalModel(existing);
              result = existing;
            } else {
              const newModel = await memory.createMentalModel(
                request.data.name || slug,
                request.data.category || "concept",
                request.data.description || ""
              );
              if (request.data.beliefs) newModel.beliefs = request.data.beliefs;
              if (request.data.openLoops) newModel.openLoops = request.data.openLoops;
              if (request.data.constraints) newModel.constraints = request.data.constraints;
              if (request.data.relationships) newModel.relationships = request.data.relationships;
              if (request.data.conversations) newModel.conversations = request.data.conversations;
              if (request.data.agents) newModel.agents = request.data.agents;
              await memory.saveMentalModel(newModel);
              result = newModel;
            }
          }
        }
        break;

      case "search_models":
        result = request.query ? await memory.searchMentalModels(request.query) : [];
        break;
        
      case "get_schema":
        result = request.category ? await memory.getSchema(request.category) : null;
        break;
        
      case "update_schema":
        if (request.category && request.data) {
          result = await memory.addFieldToSchema(request.category, request.data);
        }
        break;


      case "get_l0_index":
        result = await memory.getL0MemoryIndex();
        break;

      case "get_model_detail":
        if (request.modelSlug) {
          result = await memory.getMentalModel(request.modelSlug);
        }
        break;

      case "get_thread_detail":
        if (request.data?.threadId) {
          result = await memory.getThread(request.data.threadId);
        }
        break;

      case "get_recent_history": {
        // Return last N messages from the most recently active thread
        const limit = request.data?.limit || 20;
        const summaries = await memory.getAllThreadSummaries();
        if (summaries.length > 0) {
          // Sort by lastActiveAt descending
          summaries.sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));
          const activeThread = await memory.getThread(summaries[0].id);
          if (activeThread?.messages?.length) {
            result = {
              threadId: summaries[0].id,
              messages: activeThread.messages.slice(-limit).map((m: any) => ({
                role: m.role || "unknown",
                content: m.content || "",
              })),
            };
          } else {
            result = { threadId: null, messages: [] };
          }
        } else {
          result = { threadId: null, messages: [] };
        }
        break;
      }

      // ── Task Tracking ──────────────────────────────

      case "create_task":
        if (request.data) {
          result = await memory.createTask(request.data);
        }
        break;

      case "update_task":
        if (request.data?.taskId) {
          const { taskId, ...updates } = request.data;
          result = await memory.updateTask(taskId, updates);
        }
        break;

      case "update_task_step":
        if (request.data?.taskId && request.data?.stepId) {
          const { taskId, stepId, ...updates } = request.data;
          result = await memory.updateTaskStep(taskId, stepId, updates);
        }
        break;

      case "get_task":
        if (request.data?.taskId) {
          result = await memory.getTask(request.data.taskId);
        }
        break;

      case "get_tasks":
        result = await memory.getTasks(request.data);
        break;

      case "get_resumable_tasks":
        result = await memory.getResumableTasks(request.data?.maxRetries);
        break;

      case "flush_session":
        result = await memory.flushSession();
        break;

      case "clear_threads":
        result = await memory.clearAllThreads();
        break;

      case "get_identity":
        result = await memory.loadIdentity();
        break;

      case "get_model_skeletons": {
        const slugs: string[] = request.data?.slugs || [];
        result = await memory.getModelSkeletons(slugs);
        break;
      }

      case "search_and_promote": {
        const promoted = await memory.searchAndPromote(request.query || "");
        result = { promoted };
        break;
      }

      case "promote_model": {
        if (request.modelSlug) {
          const success = await memory.promoteModel(request.modelSlug);
          result = { promoted: success, slug: request.modelSlug };
        }
        break;
      }
    }
    
    send({
      type: "memory_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: request.requestId,
        success: true,
        data: result
      }
    });
    
    console.log(`[Agent] Memory ${request.action} complete`);
  } catch (error) {
    send({
      type: "memory_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: request.requestId,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }
    });
    console.error(`[Agent] Memory ${request.action} failed:`, error);
  }
}

// ============================================
// SKILL REQUESTS
// ============================================

export async function handleSkillRequest(request: SkillRequest, send: SendFn): Promise<void> {
  console.log(`[Agent] Skill ${request.action}: ${request.skillSlug || request.query || ""}`);
  
  try {
    let result: any;
    
    switch (request.action) {
      case "get_index":
        result = await memory.getAllSkills();
        break;
        
      case "get_skill":
        result = request.skillSlug ? await memory.getSkill(request.skillSlug) : null;
        break;
        
      case "create_skill":
        if (request.data) {
          result = await memory.createSkill(
            request.data.name,
            request.data.description,
            request.data.content || "",
            request.data.tags || [],
          );
        }
        break;
        
      case "search_skills":
        result = await memory.searchSkills(request.query ?? "");
        break;
        
      case "delete_skill":
        if (request.skillSlug) {
          result = await memory.deleteSkill(request.skillSlug);
        }
        break;
    }
    
    send({
      type: "skill_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: request.requestId,
        success: true,
        data: result
      }
    });
    
    console.log(`[Agent] Skill ${request.action} complete`);
  } catch (error) {
    send({
      type: "skill_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: request.requestId,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }
    });
    console.error(`[Agent] Skill ${request.action} failed:`, error);
  }
}
