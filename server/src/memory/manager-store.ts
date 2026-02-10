/**
 * Memory Manager — Shared Store
 * 
 * Singleton in-memory store used by all manager-* modules.
 * Replace with DB in production.
 */

import type {
  Thread,
  MentalModel,
  SessionMemory,
} from "../types.js";

export interface MemoryStore {
  threads: Map<string, Thread>;
  mentalModels: Map<string, MentalModel>;
  sessions: Map<string, SessionMemory>;
  userThreads: Map<string, string[]>;
  userModels: Map<string, string[]>;
  userSessions: Map<string, string>;
}

export const store: MemoryStore = {
  threads: new Map(),
  mentalModels: new Map(),
  sessions: new Map(),
  userThreads: new Map(),
  userModels: new Map(),
  userSessions: new Map(),
};
