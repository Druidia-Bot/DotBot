/**
 * Regression tests for schedule-calc timezone handling.
 *
 * The original bug: dateInTimezone() used `new Date(year, month, day, hour, ...)`
 * which constructs in the SERVER's local timezone (UTC on Linode), not the target
 * timezone. So "4:00 AM America/New_York" became 4:00 AM UTC (11:00 PM Eastern).
 */

import { describe, it, expect } from "vitest";
import { calculateNextRun } from "./schedule-calc.js";

describe("calculateNextRun — timezone handling", () => {
  // Feb 20, 2026 00:36 UTC = Feb 19, 2026 7:36 PM Eastern (EST, UTC-5)
  const after = new Date("2026-02-20T00:36:00Z");

  it("daily 04:00 Eastern should produce 09:00 UTC (not 04:00 UTC)", () => {
    const result = calculateNextRun(
      { type: "daily", time: "04:00" },
      after,
      "America/New_York",
    );

    // 4:00 AM Eastern on Feb 20 = 09:00 UTC on Feb 20
    expect(result.toISOString()).toBe("2026-02-20T09:00:00.000Z");
  });

  it("daily 18:00 Eastern should produce 23:00 UTC same day", () => {
    const result = calculateNextRun(
      { type: "daily", time: "18:00" },
      after,
      "America/New_York",
    );

    // 6:00 PM Eastern on Feb 19 is already past (it's 7:36 PM Eastern)
    // So next run is Feb 20 at 6:00 PM Eastern = Feb 20 23:00 UTC
    expect(result.toISOString()).toBe("2026-02-20T23:00:00.000Z");
  });

  it("daily 04:00 UTC should produce 04:00 UTC", () => {
    const result = calculateNextRun(
      { type: "daily", time: "04:00" },
      after,
      "UTC",
    );

    // 4:00 AM UTC on Feb 20 is still in the future (it's 00:36 UTC)
    expect(result.toISOString()).toBe("2026-02-20T04:00:00.000Z");
  });

  it("daily 00:00 UTC should advance to next day when already past", () => {
    const result = calculateNextRun(
      { type: "daily", time: "00:00" },
      after,
      "UTC",
    );

    // 00:00 UTC on Feb 20 is already past (it's 00:36 UTC)
    // So next run is Feb 21 00:00 UTC
    expect(result.toISOString()).toBe("2026-02-21T00:00:00.000Z");
  });

  it("daily 19:00 Eastern should be today when not yet past", () => {
    // 7:00 PM Eastern = 00:00 UTC next day. It's 7:36 PM Eastern, so 19:00 is past.
    // Next run should be tomorrow 19:00 Eastern = Feb 21 00:00 UTC
    const result = calculateNextRun(
      { type: "daily", time: "19:00" },
      after,
      "America/New_York",
    );

    expect(result.toISOString()).toBe("2026-02-21T00:00:00.000Z");
  });

  it("weekly schedule respects timezone", () => {
    // Feb 20, 2026 is a Friday. after is Feb 19 7:36 PM Eastern (Thursday).
    // Schedule: weekly on Friday (5) at 04:00 Eastern
    const result = calculateNextRun(
      { type: "weekly", time: "04:00", dayOfWeek: 5 },
      after,
      "America/New_York",
    );

    // Friday Feb 20 at 4:00 AM Eastern = Feb 20 09:00 UTC
    expect(result.toISOString()).toBe("2026-02-20T09:00:00.000Z");
  });

  it("weekly schedule advances to next week when day already passed", () => {
    // after is Thursday evening Eastern. Schedule: weekly on Wednesday (3) at 10:00 Eastern
    const result = calculateNextRun(
      { type: "weekly", time: "10:00", dayOfWeek: 3 },
      after,
      "America/New_York",
    );

    // Next Wednesday is Feb 25. 10:00 AM Eastern = 15:00 UTC
    expect(result.toISOString()).toBe("2026-02-25T15:00:00.000Z");
  });
});

describe("calculateNextRun — DST transition", () => {
  it("handles spring-forward (EST→EDT) correctly", () => {
    // DST starts March 8, 2026 at 2:00 AM Eastern (clocks spring forward to 3:00 AM)
    // Schedule: daily at 04:00 Eastern
    // On March 7 (before DST): 4:00 AM EST = 09:00 UTC (UTC-5)
    // On March 8 (after DST):  4:00 AM EDT = 08:00 UTC (UTC-4)
    const beforeDST = new Date("2026-03-07T10:00:00Z"); // March 7, 5:00 AM EST
    const result = calculateNextRun(
      { type: "daily", time: "04:00" },
      beforeDST,
      "America/New_York",
    );

    // 4:00 AM EST on March 7 is already past (it's 5:00 AM EST)
    // Next: March 8 at 4:00 AM EDT = 08:00 UTC
    expect(result.toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });
});
