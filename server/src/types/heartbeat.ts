/**
 * Heartbeat Types
 *
 * Result structure for periodic heartbeat checks.
 */

export interface HeartbeatResult {
  status: "ok" | "alert" | "error";
  content: string;          // Display text (alert message or brief summary)
  checkedAt: string;        // ISO timestamp when the check completed
  durationMs: number;       // How long the server-side evaluation took
  model: string;            // Which LLM model was used
  toolsAvailable: boolean;  // Whether tool loop was available for this check
  scheduledTasks?: {        // #5: Scheduler integration — task counts for this user
    due: number;            // Tasks past their scheduled time
    upcoming: number;       // Tasks scheduled within the next hour
    total: number;          // Total scheduled (not yet executed) tasks
  };
}
