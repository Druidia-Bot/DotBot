/**
 * Periodic Module
 * 
 * Unified periodic task management for the local agent.
 */

export {
  startPeriodicManager,
  stopPeriodicManager,
  notifyActivity,
  getIdleDurationMs,
  isAnyTaskRunning,
  isTaskRunning,
  getManagerStatus,
  _resetForTesting,
  type PeriodicTaskDef,
  type ManagerStatus,
} from "./manager.js";
