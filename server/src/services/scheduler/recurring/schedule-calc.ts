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

  // Get current wall-clock date in the target timezone
  const wall = getWallClock(after, timezone);

  // Build today's target in the target timezone, then convert to UTC
  let target = wallClockToUTC(wall.year, wall.month, wall.day, hours, minutes, timezone);

  // If target is in the past or exactly now, advance to tomorrow
  if (target <= after) {
    // Advance wall-clock day by 1
    const tomorrow = new Date(after.getTime() + 86_400_000);
    const wallTomorrow = getWallClock(tomorrow, timezone);
    target = wallClockToUTC(wallTomorrow.year, wallTomorrow.month, wallTomorrow.day, hours, minutes, timezone);
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

  // Get current wall-clock date in the target timezone
  const wall = getWallClock(after, timezone);

  // Figure out how many days until the target day of week
  // wall.dayOfWeek is 0=Sun..6=Sat
  let daysUntil = dayOfWeek - wall.dayOfWeek;
  if (daysUntil < 0) daysUntil += 7;

  // Build candidate in the target timezone
  const candidateMs = after.getTime() + daysUntil * 86_400_000;
  const candidateWall = getWallClock(new Date(candidateMs), timezone);
  let target = wallClockToUTC(candidateWall.year, candidateWall.month, candidateWall.day, hours, minutes, timezone);

  // If same day but already past, advance by 7 days
  if (daysUntil === 0 && target <= after) {
    const nextWeekMs = after.getTime() + 7 * 86_400_000;
    const nextWeekWall = getWallClock(new Date(nextWeekMs), timezone);
    target = wallClockToUTC(nextWeekWall.year, nextWeekWall.month, nextWeekWall.day, hours, minutes, timezone);
  }

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

/** Wall-clock components in a target timezone. */
interface WallClock {
  year: number;
  month: number;   // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number; // 0=Sun..6=Sat
}

/**
 * Read the wall-clock time in a timezone for a given UTC instant.
 */
function getWallClock(date: Date, timezone: string): WallClock {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) =>
    parseInt(parts.find(p => p.type === type)?.value || "0");

  // Intl weekday "short" in en-US: Sun, Mon, Tue, Wed, Thu, Fri, Sat
  const weekdayStr = parts.find(p => p.type === "weekday")?.value || "Sun";
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    dayOfWeek: dayMap[weekdayStr] ?? 0,
  };
}

/**
 * Convert a wall-clock time in a timezone to a UTC Date.
 *
 * Strategy: construct a UTC guess, read what wall-clock that produces in the
 * target timezone, then adjust by the difference. This handles DST correctly
 * because we measure the actual offset at the target instant.
 */
function wallClockToUTC(
  year: number, month: number, day: number,
  hour: number, minute: number,
  timezone: string,
): Date {
  const desiredMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Initial guess: treat the wall-clock values as UTC
  let candidate = new Date(desiredMs);

  // Two iterations: the first corrects by the offset at the guess point,
  // the second corrects for DST boundaries where the offset at the guess
  // differs from the offset at the target.
  for (let i = 0; i < 2; i++) {
    const wall = getWallClock(candidate, timezone);
    const wallMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
    const drift = wallMs - desiredMs;
    if (drift === 0) break;
    candidate = new Date(candidate.getTime() - drift);
  }

  return candidate;
}
