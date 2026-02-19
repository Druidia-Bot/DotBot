---
name: process-emails
description: Autonomous email processing using Gmail MCP + rulesets. Fetches recent emails, applies a ruleset for triage (archive, flag, reply), and executes the action plan.
tags: [email, gmail, triage, ruleset, automation, inbox]
disable-model-invocation: false
user-invocable: true
allowed-tools: [rules.list, rules.read, rules.save, rules.add_rule, rules.remove_rule, rules.edit_rule, rules.evaluate, result.overview, result.get, result.filter, tools.execute, tools.list_tools]
---

# Process Emails — Inbox Triage with Rulesets

## EXECUTION MODEL
This skill runs **autonomously**. Execute all tool calls yourself — do NOT stop between steps or ask the user for permission.

## Overview
Fetch recent emails via Gmail MCP, apply a triage ruleset to classify and prioritize them, then present an action plan for the user to confirm.

## Pre-Flight Checks

1. **Gmail MCP available?** — call `tools.list_tools({ category: "mcp" })` and look for Gmail-related tools (e.g., `mcp.gmail.*` or similar).
   - If no Gmail tools found: tell the user to connect Gmail via `/mcp-setup` first.
2. **Email triage ruleset exists?** — call `rules.list()` and look for an `email-triage` slug.
   - If not found: create a starter ruleset (see Step 1 below).

## Step 1: Ensure Ruleset Exists

Check for `email-triage` ruleset:
```
rules.read({ slug: "email-triage" })
```

If it doesn't exist, create a sensible default:
```
rules.save({
  name: "Email Triage",
  slug: "email-triage",
  description: "Daily inbox processing — archive noise, flag urgent items, surface what needs a reply",
  rules: [
    {
      id: "r1",
      assess: "Is this a promotional newsletter, marketing email, or automated notification that requires no action?",
      scale: [0, 1],
      threshold: 1,
      when_above: "Archive it.",
      when_below: null
    },
    {
      id: "r2",
      assess: "How urgently does this email need a response? Consider deadlines, sender importance, and time sensitivity.",
      scale: [1, 10],
      threshold: 7,
      when_above: "Flag as urgent — needs response today.",
      when_below: null
    },
    {
      id: "r3",
      assess: "Does this email require a personal reply (not just acknowledgment)?",
      scale: [0, 1],
      threshold: 1,
      when_above: "Draft a reply.",
      when_below: null
    },
    {
      id: "r4",
      assess: "Does this email contain a task, action item, or commitment that should be tracked?",
      scale: [0, 1],
      threshold: 1,
      when_above: "Extract the action item and add to tasks.",
      when_below: null
    }
  ]
})
```

Tell the user the ruleset was created and they can customize it with `rules.edit_rule` or `rules.add_rule`.

## Step 2: Fetch Recent Emails

Use the Gmail MCP tool to fetch recent emails. The exact tool name depends on the MCP configuration — common patterns:

```
tools.execute({
  tool_id: "mcp.gmail.search_emails",
  args: { query: "is:inbox newer_than:1d", maxResults: 50 }
})
```

Or if the tool uses a different name:
```
tools.execute({
  tool_id: "mcp.gmail.list_messages",
  args: { query: "is:inbox newer_than:1d", maxResults: 50 }
})
```

If neither works, use `tools.list_tools({ source: "mcp" })` to find the correct Gmail tool name, then call it.

The collection pipeline will automatically capture the large result and return a collection overview with a `collectionId`.

## Step 3: Review the Collection

The previous step should produce a collection overview. Note the `collectionId`.

Use `result.overview` if you need to see the collection again:
```
result.overview({ collectionId: "<col_id>" })
```

Optionally use `result.filter` to scope down:
```
result.filter({ collectionId: "<col_id>", field: "labelIds", operator: "contains", value: "INBOX" })
```

## Step 4: Evaluate Against Ruleset

Pass the collection items to the evaluation engine:
```
rules.evaluate({
  slug: "email-triage",
  collectionId: "<col_id>"
})
```

If the collection has >50 emails, you'll get a confirmation prompt. Confirm:
```
rules.evaluate({
  slug: "email-triage",
  collectionId: "<col_id>",
  confirmed: true
})
```

## Step 5: Present Action Plan

The evaluation returns a structured report showing which rules fired on which emails. Present it clearly:

### Format
```
## Email Triage Results — [date]

**Summary:**
- X emails processed
- Y to archive (newsletters/promos)
- Z flagged as urgent
- W need a reply
- V contain action items

### Urgent (needs response today)
1. From: [sender] — Subject: [subject]
   → Flag as urgent

### Needs Reply
1. From: [sender] — Subject: [subject]
   → Draft a reply

### Action Items
1. From: [sender] — [extracted action item]

### Archive
1. [newsletter name] — [subject]
...

Shall I proceed with these actions?
```

## Step 6: Execute Actions (on confirmation)

After the user confirms:

1. **Archive**: Use Gmail MCP to modify labels (remove INBOX, add archive)
2. **Flag urgent**: Add a STARRED or IMPORTANT label
3. **Draft replies**: Use the LLM to draft contextual replies, present for review
4. **Extract action items**: Save to knowledge base or present as a task list

**Do NOT execute actions without user confirmation.** The evaluation step produces a plan — the user must approve before you modify their inbox.

## Customization

Users can modify the ruleset at any time:

- **Add a rule**: `rules.add_rule({ slug: "email-triage", assess: "...", scale: [0,1], threshold: 1, when_above: "..." })`
- **Edit a rule**: `rules.edit_rule({ slug: "email-triage", ruleId: "r2", assess: "...", scale: [1,10], threshold: 8, when_above: "..." })`
- **Remove a rule**: `rules.remove_rule({ slug: "email-triage", ruleId: "r4" })`
- **View current rules**: `rules.read({ slug: "email-triage" })`

## Troubleshooting

### "No Gmail tools found"
The user needs to connect Gmail as an MCP server. Suggest: "Run `/mcp-setup` to connect your Gmail account."

### "0 emails" or empty collection
- Check the search query — `newer_than:1d` may need adjusting
- Try `newer_than:3d` for a wider window
- Verify the Gmail MCP server is connected: `tools.list_tools({ source: "mcp" })`

### Evaluation takes too long
Each email requires one LLM call. For large inboxes:
- Filter to unread only: `is:unread newer_than:1d`
- Use `result.filter` to narrow before evaluating
- Reduce the ruleset to essential rules only
