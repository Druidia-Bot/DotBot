/**
 * Tests for Collection Introspector
 *
 * Covers: introspect, hintsMatchStructure, extractItems, extractSummaryFields
 * with realistic Gmail, Calendar, and CRM-style fixtures.
 */

import { describe, it, expect } from "vitest";
import { introspect, hintsMatchStructure, extractItems, extractSummaryFields } from "../introspector.js";

// ============================================
// FIXTURES
// ============================================

/** Realistic Gmail message list (simplified from actual API response). */
const GMAIL_FIXTURE = JSON.stringify({
  messages: [
    {
      id: "18de1a2b3c4d5e6f",
      threadId: "18de1a2b3c4d5e6f",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Hey Jesse, just following up on our conversation about the deployment...",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "alice@example.com" },
          { name: "To", value: "jesse@example.com" },
          { name: "Subject", value: "Re: Deployment schedule" },
          { name: "Date", value: "Wed, 19 Feb 2026 10:30:00 -0500" },
          { name: "DKIM-Signature", value: "v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=selector1; " + "x".repeat(500) },
          { name: "ARC-Seal", value: "i=1; a=rsa-sha256; t=1708347000; cv=none; d=google.com; s=arc-20160816; " + "y".repeat(500) },
        ],
        body: { size: 0 },
        parts: [
          { mimeType: "text/plain", body: { data: "SGV5IEplc3Nl..." + "A".repeat(2000), size: 1500 } },
          { mimeType: "text/html", body: { data: "PGh0bWw+..." + "B".repeat(4000), size: 3000 } },
        ],
      },
      sizeEstimate: 15000,
      internalDate: "1708347000000",
    },
    {
      id: "28de1a2b3c4d5e6f",
      threadId: "28de1a2b3c4d5e6f",
      labelIds: ["INBOX"],
      snippet: "The quarterly report is attached. Please review before Friday.",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "bob@company.com" },
          { name: "To", value: "jesse@example.com" },
          { name: "Subject", value: "Q4 Quarterly Report" },
          { name: "Date", value: "Wed, 19 Feb 2026 09:15:00 -0500" },
          { name: "DKIM-Signature", value: "v=1; a=rsa-sha256; c=relaxed; d=company.com; s=sel2; " + "x".repeat(400) },
          { name: "ARC-Seal", value: "i=1; a=rsa-sha256; t=1708342500; cv=none; d=google.com; " + "y".repeat(400) },
        ],
        body: { size: 0 },
        parts: [
          { mimeType: "text/plain", body: { data: "VGhlIHF1YXJ0ZXI=..." + "C".repeat(1500), size: 1200 } },
        ],
      },
      sizeEstimate: 12000,
      internalDate: "1708342500000",
    },
    {
      id: "38de1a2b3c4d5e6f",
      threadId: "38de1a2b3c4d5e6f",
      labelIds: ["INBOX", "IMPORTANT"],
      snippet: "Meeting moved to 3pm. See you there!",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "carol@team.io" },
          { name: "To", value: "jesse@example.com" },
          { name: "Subject", value: "Meeting rescheduled" },
          { name: "Date", value: "Tue, 18 Feb 2026 16:00:00 -0500" },
          { name: "DKIM-Signature", value: "v=1; a=rsa-sha256; " + "z".repeat(300) },
          { name: "ARC-Seal", value: "i=1; " + "z".repeat(300) },
        ],
        body: { data: "TWVldGluZyBtb3ZlZA==", size: 45 },
      },
      sizeEstimate: 5000,
      internalDate: "1708290000000",
    },
  ],
  resultSizeEstimate: 3,
});

/** Calendar events — array nested at "items". */
const CALENDAR_FIXTURE = JSON.stringify({
  kind: "calendar#events",
  summary: "jesse@example.com",
  updated: "2026-02-19T15:00:00.000Z",
  items: [
    {
      kind: "calendar#event",
      id: "evt_abc123",
      status: "confirmed",
      summary: "Sprint Planning",
      start: { dateTime: "2026-02-19T10:00:00-05:00" },
      end: { dateTime: "2026-02-19T11:00:00-05:00" },
      organizer: { email: "carol@team.io", displayName: "Carol" },
      attendees: [
        { email: "jesse@example.com", responseStatus: "accepted" },
        { email: "alice@example.com", responseStatus: "needsAction" },
      ],
      description: "Weekly sprint planning session. " + "Details ".repeat(50),
    },
    {
      kind: "calendar#event",
      id: "evt_def456",
      status: "confirmed",
      summary: "1:1 with Bob",
      start: { dateTime: "2026-02-19T14:00:00-05:00" },
      end: { dateTime: "2026-02-19T14:30:00-05:00" },
      organizer: { email: "bob@company.com" },
      attendees: [
        { email: "jesse@example.com", responseStatus: "accepted" },
      ],
    },
  ],
});

/** CRM contacts — root-level array. */
const CRM_FIXTURE = JSON.stringify([
  {
    id: "con_001",
    name: "Acme Corp",
    email: "info@acme.com",
    phone: "+1-555-0100",
    status: "active",
    tags: ["enterprise", "high-value"],
    notes: "Long-standing customer since 2020. " + "History ".repeat(100),
    lastContact: "2026-02-18T10:00:00Z",
  },
  {
    id: "con_002",
    name: "Beta LLC",
    email: "hello@beta.co",
    phone: "+1-555-0200",
    status: "lead",
    tags: ["startup"],
    notes: "Initial conversation about onboarding. " + "Notes ".repeat(80),
    lastContact: "2026-02-17T15:30:00Z",
  },
  {
    id: "con_003",
    name: "Gamma Inc",
    email: "support@gamma.io",
    phone: "+1-555-0300",
    status: "churned",
    tags: ["smb"],
    notes: "Left for competitor. " + "Details ".repeat(60),
    lastContact: "2026-01-10T09:00:00Z",
  },
]);

/** Deeply nested structure — array at data.response.records. */
const DEEP_NESTED_FIXTURE = JSON.stringify({
  data: {
    response: {
      status: "ok",
      records: [
        { id: 1, title: "Record A", value: 100 },
        { id: 2, title: "Record B", value: 200 },
      ],
    },
  },
});

/** Plain text output — line-based. */
const PLAIN_TEXT_FIXTURE = `
Server: web-prod-01 | Status: healthy | CPU: 23% | RAM: 4.2GB
Server: web-prod-02 | Status: healthy | CPU: 45% | RAM: 6.1GB
Server: db-primary  | Status: warning | CPU: 78% | RAM: 14.3GB
Server: db-replica  | Status: healthy | CPU: 12% | RAM: 8.7GB
`.trim();

// ============================================
// TESTS: introspect()
// ============================================

describe("introspect", () => {
  describe("Gmail messages", () => {
    it("finds messages array at 'messages' path", () => {
      const hints = introspect("gmail-find-email", GMAIL_FIXTURE);
      expect(hints).not.toBeNull();
      expect(hints!.arrayPath).toBe("messages");
      expect(hints!.format).toBe("json");
      expect(hints!.sampleItemCount).toBe(3);
    });

    it("classifies id, threadId, snippet as summary fields", () => {
      const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
      expect(hints.summaryFields).toContain("id");
      expect(hints.summaryFields).toContain("threadId");
      expect(hints.summaryFields).toContain("snippet");
    });

    it("classifies labelIds as summary (small array)", () => {
      const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
      expect(hints.summaryFields).toContain("labelIds");
    });

    it("classifies payload as noise (large object)", () => {
      const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
      expect(hints.noiseFields).toContain("payload");
    });

    it("promotes From, To, Subject, Date from payload.headers", () => {
      const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
      expect(hints.summaryFields).toContain("payload.headers[From]");
      expect(hints.summaryFields).toContain("payload.headers[To]");
      expect(hints.summaryFields).toContain("payload.headers[Subject]");
      expect(hints.summaryFields).toContain("payload.headers[Date]");
    });

    it("does NOT promote DKIM-Signature or ARC-Seal", () => {
      const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
      expect(hints.summaryFields).not.toContain("payload.headers[DKIM-Signature]");
      expect(hints.summaryFields).not.toContain("payload.headers[ARC-Seal]");
    });

    it("has reasonable estimatedItemSize", () => {
      const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
      // Each item is several KB (headers, body parts)
      expect(hints.estimatedItemSize).toBeGreaterThan(1000);
      expect(hints.estimatedItemSize).toBeLessThan(20000);
    });
  });

  describe("Calendar events", () => {
    it("finds items array at 'items' path", () => {
      const hints = introspect("google-calendar-list-events", CALENDAR_FIXTURE);
      expect(hints).not.toBeNull();
      expect(hints!.arrayPath).toBe("items");
      expect(hints!.sampleItemCount).toBe(2);
    });

    it("classifies summary and status as summary fields", () => {
      const hints = introspect("google-calendar-list-events", CALENDAR_FIXTURE)!;
      expect(hints.summaryFields).toContain("summary");
      expect(hints.summaryFields).toContain("status");
      expect(hints.summaryFields).toContain("id");
    });
  });

  describe("CRM contacts (root-level array)", () => {
    it("finds array at root (empty arrayPath)", () => {
      const hints = introspect("hubspot-list-contacts", CRM_FIXTURE);
      expect(hints).not.toBeNull();
      expect(hints!.arrayPath).toBe("");
      expect(hints!.sampleItemCount).toBe(3);
    });

    it("classifies name, email, phone, status as summary", () => {
      const hints = introspect("hubspot-list-contacts", CRM_FIXTURE)!;
      expect(hints.summaryFields).toContain("name");
      expect(hints.summaryFields).toContain("email");
      expect(hints.summaryFields).toContain("phone");
      expect(hints.summaryFields).toContain("status");
    });

    it("classifies notes as noise (large string)", () => {
      const hints = introspect("hubspot-list-contacts", CRM_FIXTURE)!;
      expect(hints.noiseFields).toContain("notes");
    });

    it("classifies tags as summary (small array)", () => {
      const hints = introspect("hubspot-list-contacts", CRM_FIXTURE)!;
      expect(hints.summaryFields).toContain("tags");
    });
  });

  describe("deeply nested array", () => {
    it("finds array at data.response.records", () => {
      const hints = introspect("api-query", DEEP_NESTED_FIXTURE);
      expect(hints).not.toBeNull();
      expect(hints!.arrayPath).toBe("data.response.records");
      expect(hints!.sampleItemCount).toBe(2);
    });
  });

  describe("plain text", () => {
    it("treats multi-line plain text as a collection", () => {
      const hints = introspect("server-status", PLAIN_TEXT_FIXTURE);
      expect(hints).not.toBeNull();
      expect(hints!.format).toBe("plain-text");
      expect(hints!.summaryFields).toEqual(["line"]);
      expect(hints!.sampleItemCount).toBe(4);
    });
  });

  describe("edge cases", () => {
    it("returns null for a single scalar value", () => {
      expect(introspect("test", JSON.stringify("hello"))).toBeNull();
    });

    it("returns null for an empty array", () => {
      expect(introspect("test", JSON.stringify([]))).toBeNull();
    });

    it("returns null for an object with empty array", () => {
      expect(introspect("test", JSON.stringify({ items: [] }))).toBeNull();
    });

    it("returns null for a single-line plain text", () => {
      expect(introspect("test", "just one line")).toBeNull();
    });

    it("returns null for an object with no arrays at all", () => {
      expect(introspect("test", JSON.stringify({ a: 1, b: "hello" }))).toBeNull();
    });
  });
});

// ============================================
// TESTS: hintsMatchStructure()
// ============================================

describe("hintsMatchStructure", () => {
  it("returns true when structure matches", () => {
    const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
    expect(hintsMatchStructure(hints, GMAIL_FIXTURE)).toBe(true);
  });

  it("returns true for plain text with plain-text hints", () => {
    const hints = introspect("server-status", PLAIN_TEXT_FIXTURE)!;
    expect(hintsMatchStructure(hints, PLAIN_TEXT_FIXTURE)).toBe(true);
  });

  it("returns false when arrayPath no longer resolves", () => {
    const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
    // Different structure — array at "results" instead of "messages"
    const different = JSON.stringify({ results: [{ foo: "bar" }] });
    expect(hintsMatchStructure(hints, different)).toBe(false);
  });

  it("returns false when fields have changed dramatically", () => {
    const hints = introspect("hubspot-list-contacts", CRM_FIXTURE)!;
    // Same arrayPath (root) but totally different fields
    const different = JSON.stringify([{ x: 1, y: 2, z: 3 }]);
    expect(hintsMatchStructure(hints, different)).toBe(false);
  });

  it("returns true when at least half of summary fields still exist", () => {
    const hints = introspect("hubspot-list-contacts", CRM_FIXTURE)!;
    // Keep enough summary fields (id, name, email, status, tags) to pass the half threshold
    const partial = JSON.stringify([{ id: "1", name: "Test", email: "a@b.com", status: "active", tags: ["x"], newField: 123 }]);
    expect(hintsMatchStructure(hints, partial)).toBe(true);
  });

  it("returns false for invalid JSON when hints expect JSON", () => {
    const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
    expect(hintsMatchStructure(hints, "not json at all")).toBe(false);
  });
});

// ============================================
// TESTS: extractItems()
// ============================================

describe("extractItems", () => {
  it("extracts Gmail messages using hints", () => {
    const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
    const items = extractItems(GMAIL_FIXTURE, hints);
    expect(items).toHaveLength(3);
    expect((items[0] as any).id).toBe("18de1a2b3c4d5e6f");
  });

  it("extracts CRM contacts from root array", () => {
    const hints = introspect("hubspot-list-contacts", CRM_FIXTURE)!;
    const items = extractItems(CRM_FIXTURE, hints);
    expect(items).toHaveLength(3);
    expect((items[0] as any).name).toBe("Acme Corp");
  });

  it("extracts plain text lines as objects", () => {
    const hints = introspect("server-status", PLAIN_TEXT_FIXTURE)!;
    const items = extractItems(PLAIN_TEXT_FIXTURE, hints);
    expect(items).toHaveLength(4);
    expect((items[0] as any).line).toContain("web-prod-01");
  });

  it("returns empty array on parse failure", () => {
    const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
    const items = extractItems("broken json {{{", hints);
    expect(items).toEqual([]);
  });
});

// ============================================
// TESTS: extractSummaryFields()
// ============================================

describe("extractSummaryFields", () => {
  it("extracts direct fields", () => {
    const item = { id: "abc", name: "Test", value: 42, bigBlob: "x".repeat(1000) };
    const result = extractSummaryFields(item, ["id", "name", "value"]);
    expect(result).toEqual({ id: "abc", name: "Test", value: 42 });
  });

  it("extracts bracket-notation fields (header promotion)", () => {
    const item = {
      payload: {
        headers: [
          { name: "From", value: "alice@example.com" },
          { name: "Subject", value: "Hello" },
          { name: "DKIM-Signature", value: "v=1; ..." },
        ],
      },
    };

    const result = extractSummaryFields(item, [
      "payload.headers[From]",
      "payload.headers[Subject]",
    ]);

    expect(result["payload.headers[From]"]).toBe("alice@example.com");
    expect(result["payload.headers[Subject]"]).toBe("Hello");
  });

  it("handles dot-path nested fields", () => {
    const item = { start: { dateTime: "2026-02-19T10:00:00" }, summary: "Meeting" };
    const result = extractSummaryFields(item, ["summary", "start.dateTime"]);
    expect(result.summary).toBe("Meeting");
    expect(result["start.dateTime"]).toBe("2026-02-19T10:00:00");
  });

  it("skips missing fields gracefully", () => {
    const item = { id: "abc" };
    const result = extractSummaryFields(item, ["id", "nonexistent", "also.missing"]);
    expect(result).toEqual({ id: "abc" });
  });

  it("returns empty object for non-object items", () => {
    expect(extractSummaryFields("just a string", ["id"])).toEqual({});
    expect(extractSummaryFields(null, ["id"])).toEqual({});
  });
});

// ============================================
// TESTS: Full pipeline integration
// ============================================

describe("introspect → extractItems → extractSummaryFields (integration)", () => {
  it("Gmail: introspects, extracts, and summarizes correctly", () => {
    const hints = introspect("gmail-find-email", GMAIL_FIXTURE)!;
    const items = extractItems(GMAIL_FIXTURE, hints);
    expect(items).toHaveLength(3);

    const summary = extractSummaryFields(items[0], hints.summaryFields);
    // Should have From, To, Subject from promoted headers
    expect(summary["payload.headers[From]"]).toBe("alice@example.com");
    expect(summary["payload.headers[Subject]"]).toBe("Re: Deployment schedule");
    // Should have direct fields
    expect(summary.id).toBe("18de1a2b3c4d5e6f");
    expect(summary.snippet).toContain("following up");
  });

  it("CRM: introspects, extracts, and summarizes correctly", () => {
    const hints = introspect("hubspot-list-contacts", CRM_FIXTURE)!;
    const items = extractItems(CRM_FIXTURE, hints);
    expect(items).toHaveLength(3);

    const summary = extractSummaryFields(items[1], hints.summaryFields);
    expect(summary.name).toBe("Beta LLC");
    expect(summary.email).toBe("hello@beta.co");
    expect(summary.status).toBe("lead");
    // notes should NOT be in summary (it's noise)
    expect(summary.notes).toBeUndefined();
  });
});

// ============================================
// TESTS: CSV format support
// ============================================

const CSV_FIXTURE =
  "name,email,status,score\n" +
  "Alice,alice@example.com,active,85\n" +
  "Bob,bob@test.co,lead,42\n" +
  "Charlie,charlie@gamma.io,churned,15\n";

const CSV_QUOTED_FIXTURE =
  'name,description,city\n' +
  '"Acme Corp","We sell, everything",New York\n' +
  '"Beta LLC","Software ""solutions""",London\n';

describe("CSV support", () => {
  it("detects CSV format", () => {
    const hints = introspect("csv-tool", CSV_FIXTURE)!;
    expect(hints).not.toBeNull();
    expect(hints.format).toBe("csv");
    expect(hints.summaryFields).toContain("name");
    expect(hints.summaryFields).toContain("email");
    expect(hints.summaryFields).toContain("status");
    expect(hints.summaryFields).toContain("score");
  });

  it("extracts items from CSV", () => {
    const hints = introspect("csv-tool", CSV_FIXTURE)!;
    const items = extractItems(CSV_FIXTURE, hints);
    expect(items).toHaveLength(3);
    expect((items[0] as any).name).toBe("Alice");
    expect((items[0] as any).email).toBe("alice@example.com");
    expect((items[1] as any).status).toBe("lead");
    expect((items[2] as any).score).toBe("15");
  });

  it("handles quoted CSV fields", () => {
    const hints = introspect("csv-quoted", CSV_QUOTED_FIXTURE)!;
    expect(hints).not.toBeNull();
    expect(hints.format).toBe("csv");

    const items = extractItems(CSV_QUOTED_FIXTURE, hints);
    expect(items).toHaveLength(2);
    expect((items[0] as any).name).toBe("Acme Corp");
    expect((items[0] as any).description).toBe("We sell, everything");
    expect((items[1] as any).description).toBe('Software "solutions"');
  });

  it("hintsMatchStructure works for CSV", () => {
    const hints = introspect("csv-tool", CSV_FIXTURE)!;
    expect(hintsMatchStructure(hints, CSV_FIXTURE)).toBe(true);

    // Different columns should fail
    const different = "x,y,z\n1,2,3\n";
    expect(hintsMatchStructure(hints, different)).toBe(false);
  });

  it("does not detect JSON as CSV", () => {
    const json = JSON.stringify([{ a: 1 }]);
    const hints = introspect("json-tool", json)!;
    expect(hints.format).toBe("json");
  });

  it("does not detect single-column text as CSV", () => {
    const text = "line1\nline2\nline3\n";
    const hints = introspect("text-tool", text)!;
    // Single column → not CSV, should be plain-text
    expect(hints.format).toBe("plain-text");
  });
});
