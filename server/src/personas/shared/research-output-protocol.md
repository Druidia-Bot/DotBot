# Standard Research Output Protocol

**Version:** 1.0
**Purpose:** Ensure consistent research artifact storage across all agents

---

## Your Workspace

All paths below refer to **your agent's isolated workspace** at:

```
~/.bot/agent-workspaces/[agent-id]/
```

This workspace persists for **24 hours after task completion**, giving users time to review your work before automatic cleanup.

---

## Required Outputs for All Research Tasks

### 1. Research Notes → `workspace/research/[descriptive-name]-[YYYY-MM-DD].md`

**Purpose:** Complete research artifacts for future reference and debugging

**Content:**
- All data sources with URLs
- Raw findings and quotes
- Analysis methodology
- Tool calls made and results
- Edge cases and limitations discovered
- Structured for future agents to pick up where you left off

**Naming convention:**
- `workspace/research/stock-analysis-2026-02-11.md`
- `workspace/research/competitor-research-2026-02-11.md`
- `workspace/research/api-documentation-review-2026-02-11.md`

**Example structure:**
```markdown
# [Research Topic] — [Date]

## Methodology
[How you approached the research]

## Data Sources
- [Source 1 with URL]
- [Source 2 with URL]

## Findings

### [Topic Area 1]
[Detailed findings with quotes and data]

### [Topic Area 2]
[Detailed findings with quotes and data]

## Open Questions
[Anything unresolved or requiring follow-up]

## Raw Data
[Tool outputs, API responses, screenshots]
```

---

### 2. Executive Summary → `workspace/output/report.md`

**Purpose:** User-facing deliverable with clean formatting

**Content:**
- Key findings (3-5 bullet points)
- Recommendations
- Charts, tables, visual summaries
- Next steps or follow-up actions
- Clear, non-technical language

**Format:**
```markdown
# [Research Title]

## Summary
[1-2 sentence overview]

## Key Findings
1. [Finding 1 with evidence]
2. [Finding 2 with evidence]
3. [Finding 3 with evidence]

## Recommendations
- [Action item 1]
- [Action item 2]

## Next Steps
[What the user should do with this information]
```

---

### 3. Tool Call Log → `workspace/logs/tool-calls.jsonl`

**Automatically created by the system.** Contains:
- Every tool call made (tool ID, inputs, outputs)
- Timestamps and durations
- Useful for debugging and understanding your research path

---

## When to Save to Knowledge Instead

**Only use `knowledge.save()` when:**
- User explicitly says something is important ("remember this", "save this")
- Creating a persistent watchlist or tracking document
- Storing user preferences or settings
- Building a reference library the user requested

**Do NOT use knowledge for:**
- General research findings (use workspace files)
- Temporary analysis
- Exploratory work

---

## Special Case: Long Tasks (Regrouping)

If you exceed 15+ tool calls and need to regroup:

1. **Save current progress** to `workspace/research/progress-checkpoint.md`
2. **Include:**
   - What you've learned so far
   - What you still need to find
   - Next steps
3. **Reference it** in your next iteration to avoid repeating work

---

## Debugging Benefits

This protocol enables:
- Users can review your research files before 24-hour cleanup
- Future agents can continue your work by reading workspace files
- Developers can trace your research path via tool-calls.jsonl
- Reflector can analyze patterns and suggest skill creation

---

## CRITICAL: Check for Previous Research First

**BEFORE starting any research, ALWAYS call `research.list` to check if you've already researched this topic:**

```javascript
research.list({})
```

If previous research exists:
1. Use `file.read` to view the previous findings
2. Build on that work instead of starting from scratch
3. Update existing research or create a follow-up file
4. Reference previous research in your new findings

This prevents duplicate work and ensures continuity across multiple research sessions.

---

## Implementation

**Use the `research.save` tool to save all research output:**

```javascript
research.save({
  title: "LYFT Stock Analysis",  // Short, descriptive title
  type: "market-analysis",       // market-analysis | news-summary | general-research | competitive-analysis
  detailedNotes: `# Full Research

## Methodology
[How you approached the research]

## Findings
[All your findings, data, analysis in markdown]

## Sources
- [URLs and references]`,
  executiveSummary: `Brief 2-3 paragraph summary with key takeaways and recommendations.`,
  tags: ["LYFT", "stocks", "rideshare"],  // Optional
  metadata: { ticker: "LYFT", sector: "Transportation" }  // Optional
})
```

This automatically creates both `workspace/research/[slug]-[date].md` and `workspace/output/report.md` with proper frontmatter.
