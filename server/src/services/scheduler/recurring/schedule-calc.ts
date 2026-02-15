/**
 * Recurring Tasks — Schedule Calculation
 *
 * Calculates the next run time for daily, weekly, hourly, and interval schedules.
 * Handles timezone conversion using Intl.DateTimeFormat.
 */

import type { TaskSchedule } from "../recurring-types.js";

// ============================================
// MAIN ENTRY
// ============================================

/**
 * Calculate the next run time for a schedule.
 * Mirrors the client-side logic in local-agent/src/scheduled-tasks/store.ts
 * but uses explicit timezone instead of system local time.
 *
 * @param schedule - The schedule definition
 * @param after - Calculate next run after this time
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 */
export function calculateNextRun(
  schedule: TaskSchedule,
  after: Date,
  timezone: string = "UTC"
): Date {
  switch (schedule.type) {
    case "daily":
      return calculateNextDaily(schedule.time || "09:00", after, timezone);
    case "weekly":
      return calculateNextWeekly(
        schedule.time || "09:00",
        schedule.dayOfWeek ?? 1,
        after,
        timezone
      );
    case "hourly":
      return calculateNextHourly(after);
    case "interval":
      return calculateNextInterval(schedule.intervalMinutes || 60, after);
    default:
      // Fallback: 1 hour from now
      return new Date(after.getTime() + 3_600_000);
  }
}

// ============================================
// SCHEDULE TYPE CALCULATORS
// ============================================

function calculateNextDaily(
  time: string,
  after: Date,
  timezone: string
): Date {
  const [hours, minutes] = parseTime(time);

  // Create target in the specified timezone
  const target = dateInTimezone(after, timezone);
  target.setHours(hours, minutes, 0, 0);

  // If target is in the past or exactly now, advance to tomorrow
  if (target <= after) {
    target.setDate(target.getDate() + 1);
    target.setHours(hours, minutes, 0, 0);
  }

  return target;
}

function calculateNextWeekly(
  time: string,
  dayOfWeek: number,
  after: Date,
  timezone: string
): Date {
  const [hours, minutes] = parseTime(time);

  const target = dateInTimezone(after, timezone);
  target.setHours(hours, minutes, 0, 0);

  // Advance to the correct day of week
  const currentDay = target.getDay();
  let daysUntil = dayOfWeek - currentDay;
  if (daysUntil < 0) daysUntil += 7;
  if (daysUntil === 0 && target <= after) daysUntil = 7;

  target.setDate(target.getDate() + daysUntil);
  target.setHours(hours, minutes, 0, 0);

  return target;
}

function calculateNextHourly(after: Date): Date {
  const target = new Date(after);
  target.setMinutes(0, 0, 0);
  target.setHours(target.getHours() + 1);
  return target;
}

function calculateNextInterval(intervalMinutes: number, after: Date): Date {
  const ms = Math.max(intervalMinutes, 5) * 60_000;
  return new Date(after.getTime() + ms);
}

// ============================================
// HELPERS
// ============================================

function parseTime(time: string): [number, number] {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return [9, 0]; // Default 9:00 AM
  const h = parseInt(match[1]);
  const m = parseInt(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return [9, 0];
  return [h, m];
}

/**
 * Create a Date object adjusted for a timezone.
 * Uses Intl.DateTimeFormat to get the offset, then adjusts.
 *
 * ⚠️ LIMITATION: This is a simplified timezone handler for basic use cases.
 * It may not handle DST transitions correctly or work reliably across all timezones.
 * For production use with complex timezone requirements, consider using:
 * - luxon (https://moment.github.io/luxon/)
 * - date-fns-tz (https://github.com/marnusw/date-fns-tz)
 *
 * Current implementation works for common timezones (America/New_York, Europe/London, etc.)
 * but may fail on DST boundaries or with historical dates.
 */
function dateInTimezone(date: Date, timezone: string): Date {
  try {
    // Get the timezone offset by formatting and parsing
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string) =>
      parseInt(parts.find(p => p.type === type)?.value || "0");

    // Reconstruct date in target timezone
    // NOTE: This creates a local Date object with the timezone's wall-clock time
    // DST transitions may cause unexpected behavior
    const tzDate = new Date(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second")
    );
    return tzDate;
  } catch (err) {
    // Invalid timezone — fall back to original date
    // In production, this should log the error for debugging
    return new Date(date);
  }
}
