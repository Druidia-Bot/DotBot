/**
 * Deferred Tasks — Time Parser
 *
 * Parse a human-readable time expression into a Date.
 * Supports: "in 30 minutes", "at 1:15 PM", "in 2 hours", "tomorrow 10am", ISO strings.
 */

export function parseScheduleTime(expression: string): Date | null {
  const now = new Date();
  const lower = expression.trim().toLowerCase();

  // ISO date string
  if (/^\d{4}-\d{2}-\d{2}/.test(lower)) {
    const d = new Date(expression);
    return isNaN(d.getTime()) ? null : d;
  }

  // "in X minutes/hours/seconds"
  const relativeMatch = lower.match(/^in\s+(\d+)\s+(second|minute|hour|day)s?$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2];
    const ms = {
      second: 1000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
    }[unit] || 60_000;
    return new Date(now.getTime() + amount * ms);
  }

  // "at HH:MM" or "at H:MM AM/PM"
  const atTimeMatch = lower.match(/^at\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (atTimeMatch) {
    let hours = parseInt(atTimeMatch[1]);
    const minutes = parseInt(atTimeMatch[2]);
    const ampm = atTimeMatch[3];

    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    // If the time has already passed today, schedule for tomorrow
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  // "tomorrow" or "tomorrow at HH:MM"
  const tomorrowMatch = lower.match(/^tomorrow(?:\s+(?:at\s+)?(\d{1,2}):?(\d{2})?\s*(am|pm)?)?$/);
  if (tomorrowMatch) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);

    if (tomorrowMatch[1]) {
      let hours = parseInt(tomorrowMatch[1]);
      const minutes = parseInt(tomorrowMatch[2] || "0");
      const ampm = tomorrowMatch[3];

      if (ampm === "pm" && hours < 12) hours += 12;
      if (ampm === "am" && hours === 12) hours = 0;

      target.setHours(hours, minutes, 0, 0);
    } else {
      target.setHours(10, 0, 0, 0); // Default: tomorrow 10 AM
    }
    return target;
  }

  // Fallback: try to parse as-is
  const parsed = new Date(expression);
  return isNaN(parsed.getTime()) ? null : parsed;
}
