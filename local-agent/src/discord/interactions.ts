/**
 * Discord Interaction Dispatch
 *
 * Manages button click (MESSAGE_COMPONENT) routing.
 * Handlers are registered by prefix — e.g. registerInteraction("confirm", fn)
 * catches any button with custom_id="confirm:..." .
 *
 * The adapter registers its own "prompt" handler during init so this module
 * stays free of orchestration state.
 */

import type { DiscordInteraction } from "./types.js";
import { ackInteraction } from "./rest.js";

type InteractionHandler = (interaction: DiscordInteraction, args: string) => Promise<void>;

const interactionHandlers = new Map<string, InteractionHandler>();

/**
 * Register a handler for button interactions with a given custom_id prefix.
 * Example: registerInteraction("confirm", handler) catches custom_id="confirm:payload".
 */
export function registerInteraction(
  prefix: string,
  handler: InteractionHandler,
): void {
  interactionHandlers.set(prefix, handler);
}

/**
 * Dispatch a Discord interaction to the matching registered handler.
 * Called by the gateway's onInteraction callback.
 */
export async function handleDiscordInteraction(
  interaction: DiscordInteraction,
  authorizedUserId: string | null,
): Promise<void> {
  // Only handle authorized users
  if (authorizedUserId && interaction.user.id !== authorizedUserId) {
    await ackInteraction(interaction, "You're not authorized to use these buttons.", true);
    return;
  }

  const customId = interaction.data.custom_id;
  console.log(`[Discord] Button clicked: custom_id="${customId}" by ${interaction.user.username}`);

  // Parse prefix:args pattern
  const colonIdx = customId.indexOf(":");
  const prefix = colonIdx >= 0 ? customId.substring(0, colonIdx) : customId;
  const args = colonIdx >= 0 ? customId.substring(colonIdx + 1) : "";

  const handler = interactionHandlers.get(prefix);
  if (handler) {
    try {
      await handler(interaction, args);
    } catch (err: any) {
      console.error(`[Discord] Interaction handler error (${prefix}):`, err.message);
      await ackInteraction(interaction, `Error: ${err.message}`, true);
    }
    return;
  }

  // Unknown button — ACK with ephemeral message
  await ackInteraction(interaction, "This button isn't connected to any action.", true);
}
