/**
 * Message Response Tracker
 *
 * Tracks every incoming user message and ensures it gets a response within a timeout.
 * Prevents silent failures where users send messages that never get answered.
 *
 * This is critical for reliability — if a message fails at the receptionist stage,
 * gets lost in the pipeline, or fails to deliver to Discord/client, we need to know.
 */

import { createComponentLogger } from "../logging.js";

const log = createComponentLogger("message-tracker");

// ============================================
// TYPES
// ============================================

export type PipelineStage =
  | "received"         // Message received from user
  | "receptionist"     // Receptionist processing
  | "agent_spawned"    // Agent created and running
  | "agent_complete"   // Agent finished execution
  | "response_ready"   // Response generated
  | "response_sent"    // Response delivered to user
  | "failed"           // Pipeline failed at some stage
  | "timeout";         // Exceeded timeout without response

export interface MessageTracker {
  messageId: string;
  userId: string;
  channelId?: string;
  prompt: string;
  timestamp: number;
  stage: PipelineStage;
  responseReceived: boolean;
  error?: string;
  agentId?: string;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

export interface MessageTimeoutAlert {
  messageId: string;
  userId: string;
  channelId?: string;
  prompt: string;
  stage: PipelineStage;
  elapsedMs: number;
  message: string;
}

// ============================================
// CONFIGURATION
// ============================================

const MESSAGE_TIMEOUT_MS = 120_000;  // 2 minutes - if no response after this, alert
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes - clean up old tracked messages

// ============================================
// TRACKER
// ============================================

export class MessageResponseTracker {
  private messages = new Map<string, MessageTracker>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private onTimeout?: (alert: MessageTimeoutAlert) => void;

  constructor(options: { onTimeout?: (alert: MessageTimeoutAlert) => void } = {}) {
    this.onTimeout = options.onTimeout;
    this.startCleanupTimer();
  }

  /**
   * Track a new incoming message from a user.
   * Starts a timeout timer to alert if no response is sent.
   */
  trackMessage(messageId: string, userId: string, prompt: string, channelId?: string): void {
    const tracker: MessageTracker = {
      messageId,
      userId,
      channelId,
      prompt,
      timestamp: Date.now(),
      stage: "received",
      responseReceived: false,
    };

    // Set timeout timer
    tracker.timeoutTimer = setTimeout(() => {
      this.handleTimeout(messageId);
    }, MESSAGE_TIMEOUT_MS);

    this.messages.set(messageId, tracker);

    log.info("Tracking new message", {
      messageId,
      userId,
      promptLength: prompt.length,
    });
  }

  /**
   * Update the stage of a tracked message.
   * This lets us know where in the pipeline the message is.
   */
  updateStage(messageId: string, stage: PipelineStage, metadata?: { agentId?: string; error?: string }): void {
    const tracker = this.messages.get(messageId);
    if (!tracker) {
      log.warn("Attempted to update stage for untracked message", { messageId, stage });
      return;
    }

    tracker.stage = stage;

    if (metadata?.agentId) {
      tracker.agentId = metadata.agentId;
    }

    if (metadata?.error) {
      tracker.error = metadata.error;
    }

    log.debug("Message stage updated", {
      messageId,
      stage,
      agentId: tracker.agentId,
    });
  }

  /**
   * Extend the timeout for a message (e.g. when an ack is sent for a long-running task).
   * Replaces the existing timer with a new one at the specified duration.
   */
  extendTimeout(messageId: string, newTimeoutMs: number): void {
    const tracker = this.messages.get(messageId);
    if (!tracker) return;

    if (tracker.timeoutTimer) {
      clearTimeout(tracker.timeoutTimer);
    }

    tracker.timeoutTimer = setTimeout(() => {
      this.handleTimeout(messageId);
    }, newTimeoutMs);

    log.debug("Message timeout extended", { messageId, newTimeoutMs });
  }

  /**
   * Mark a message as having received a response.
   * This stops the timeout timer and allows cleanup.
   */
  markResponseSent(messageId: string): void {
    const tracker = this.messages.get(messageId);
    if (!tracker) {
      log.warn("Attempted to mark response for untracked message", { messageId });
      return;
    }

    tracker.responseReceived = true;
    tracker.stage = "response_sent";

    // Clear timeout timer
    if (tracker.timeoutTimer) {
      clearTimeout(tracker.timeoutTimer);
      tracker.timeoutTimer = undefined;
    }

    const elapsed = Date.now() - tracker.timestamp;
    log.info("Message response sent", {
      messageId,
      userId: tracker.userId,
      elapsedMs: elapsed,
    });

    // Schedule cleanup (remove after 30s to allow for any late updates)
    setTimeout(() => {
      this.messages.delete(messageId);
    }, 30_000);
  }

  /**
   * Mark a message as failed.
   * This triggers an alert and stops tracking.
   */
  markFailed(messageId: string, error: string): void {
    const tracker = this.messages.get(messageId);
    if (!tracker) {
      log.warn("Attempted to mark failure for untracked message", { messageId });
      return;
    }

    tracker.stage = "failed";
    tracker.error = error;

    // Clear timeout timer
    if (tracker.timeoutTimer) {
      clearTimeout(tracker.timeoutTimer);
      tracker.timeoutTimer = undefined;
    }

    const elapsed = Date.now() - tracker.timestamp;
    log.error("Message failed", {
      messageId,
      userId: tracker.userId,
      stage: tracker.stage,
      error,
      elapsedMs: elapsed,
    });

    // Alert about the failure
    this.onTimeout?.({
      messageId: tracker.messageId,
      userId: tracker.userId,
      channelId: tracker.channelId,
      prompt: tracker.prompt,
      stage: tracker.stage,
      elapsedMs: elapsed,
      message: `Message failed at stage "${tracker.stage}": ${error}`,
    });

    // Clean up immediately
    this.messages.delete(messageId);
  }

  /**
   * Handle timeout for a message that didn't receive a response in time.
   */
  private handleTimeout(messageId: string): void {
    const tracker = this.messages.get(messageId);
    if (!tracker) return;

    // If response was already received, ignore timeout
    if (tracker.responseReceived) {
      return;
    }

    tracker.stage = "timeout";
    const elapsed = Date.now() - tracker.timestamp;

    log.warn("Message timeout - no response sent", {
      messageId,
      userId: tracker.userId,
      stage: tracker.stage,
      elapsedMs: elapsed,
      promptLength: tracker.prompt.length,
    });

    // Alert about the timeout
    this.onTimeout?.({
      messageId: tracker.messageId,
      userId: tracker.userId,
      channelId: tracker.channelId,
      prompt: tracker.prompt,
      stage: tracker.stage,
      elapsedMs: elapsed,
      message: `No response sent after ${Math.round(elapsed / 1000)}s (stuck at stage: ${tracker.stage})`,
    });
  }

  /**
   * Get the current state of a tracked message.
   */
  getMessageState(messageId: string): MessageTracker | undefined {
    return this.messages.get(messageId);
  }

  /**
   * Get all currently tracked messages (for debugging/monitoring).
   */
  getAllTrackedMessages(): MessageTracker[] {
    return Array.from(this.messages.values());
  }

  /**
   * Periodic cleanup of old completed messages.
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const toDelete: string[] = [];

      for (const [id, tracker] of this.messages) {
        const age = now - tracker.timestamp;

        // Remove messages older than 10 minutes that have received responses
        if (tracker.responseReceived && age > 600_000) {
          toDelete.push(id);
        }

        // Remove failed/timeout messages older than 5 minutes
        if ((tracker.stage === "failed" || tracker.stage === "timeout") && age > 300_000) {
          toDelete.push(id);
        }
      }

      if (toDelete.length > 0) {
        log.debug("Cleaning up old tracked messages", { count: toDelete.length });
        toDelete.forEach(id => this.messages.delete(id));
      }
    }, CLEANUP_INTERVAL_MS);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop tracking all messages and clean up.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Clear all timeout timers
    for (const tracker of this.messages.values()) {
      if (tracker.timeoutTimer) {
        clearTimeout(tracker.timeoutTimer);
      }
    }

    this.messages.clear();
    log.info("Message tracker stopped");
  }
}

/**
 * Global singleton instance for the message tracker.
 * Created on first use.
 */
let globalTracker: MessageResponseTracker | null = null;

/**
 * Get or create the global message tracker instance.
 */
export function getMessageTracker(options?: { onTimeout?: (alert: MessageTimeoutAlert) => void }): MessageResponseTracker {
  if (!globalTracker) {
    globalTracker = new MessageResponseTracker(options);
  }
  return globalTracker;
}

/**
 * Reset the global tracker (for testing).
 */
export function resetMessageTracker(): void {
  if (globalTracker) {
    globalTracker.stop();
    globalTracker = null;
  }
}
