---
name: tool-creation
description: Creates reusable tools that permanently extend DotBot's capabilities. Researches APIs, writes scripts, tests thoroughly, and saves only tools that pass the reusability gate.
tags: [tools, api, script, create, extend, capability, automation, reusable]
disable-model-invocation: true
user-invocable: true
allowed-tools: [tools.save_tool, tools.list_tools, tools.delete_tool, tools.execute, search.brave, http.request, http.render, shell.python, shell.node, shell.powershell, filesystem.read_file, filesystem.create_file]
---

# Tool Creation — Extending DotBot's Capabilities

This skill guides the creation of reusable tools that permanently extend what DotBot can do. Tools are registered and available to ALL personas in ALL future conversations.

**EXECUTION MODEL: This is a methodical skill. Research → Test → Save → Verify. Never skip testing.**

## The Reusability Gate (ALWAYS CHECK FIRST)

Before creating ANY tool, pass this checklist:

| # | Question | If NO → |
|---|----------|---------|
| 1 | Will this be useful in **3+ different future tasks**? | Don't create it — just do the task with existing tools |
| 2 | Is it **general enough** to handle variations? | Widen the scope or don't create it |
| 3 | Does a similar tool **already exist**? (`tools.list_tools`) | Use the existing tool instead |
| 4 | Is it **one clear action** (not a multi-step pipeline)? | Break it into smaller tools or don't create it |
| 5 | Can it **fail gracefully** with clear error messages? | Design error handling before writing code |

**If #1 fails — STOP. Tell the user why a permanent tool isn't warranted and offer to just do the task directly.**

## Tool Types

### API Tools (for external services)

Best for: weather, geocoding, translation, stock prices, public data APIs.

```
Execution Flow:
1. search.brave("free {topic} API no auth")     ← find candidates
2. http.render(docs_url)                         ← read API docs
3. http.request(test_endpoint)                   ← test manually
4. tools.save_tool({ apiSpec: {...} })           ← save if test passes
5. Call the saved tool to verify end-to-end      ← MUST verify
```

**Prefer free, no-auth APIs.** If auth is required, explain the setup cost to the user before proceeding. Use `credentialRequired` + `secrets.prompt_user` for APIs that need keys.

### Script Tools (for local processing)

Best for: data transformation, file conversion, text processing, calculations, parsing.

```
Execution Flow:
1. Design the interface (inputs → outputs)
2. Write the script
3. shell.python / shell.node to test              ← test with real data
4. tools.save_tool({ script, runtime })           ← save if test passes
5. Call the saved tool to verify end-to-end        ← MUST verify
```

**Script contract:**
- Receives args as **JSON on stdin**
- Outputs result as **JSON on stdout**
- Must handle errors (try/catch) and return `{ "error": "message" }` on failure
- Must complete in under **30 seconds**
- Should be under **100 lines** — if longer, it's too complex for a single tool

## Script Templates

### Python
```python
import sys, json

def main():
    args = json.load(sys.stdin)
    
    # Validate required params
    if "input" not in args:
        print(json.dumps({"error": "Missing required parameter: input"}))
        return
    
    try:
        # ... your logic here ...
        result = {"output": "processed data", "success": True}
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e), "success": False}))

if __name__ == "__main__":
    main()
```

### Node.js
```javascript
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
    try {
        const args = JSON.parse(input);
        if (!args.input) {
            console.log(JSON.stringify({ error: "Missing required parameter: input" }));
            return;
        }
        // ... your logic here ...
        const result = { output: "processed data", success: true };
        console.log(JSON.stringify(result));
    } catch (e) {
        console.log(JSON.stringify({ error: e.message, success: false }));
    }
});
```

## Naming Convention

Format: `category.action_noun`

| Good | Bad | Why |
|------|-----|-----|
| `weather.forecast` | `get_weather` | Missing category prefix |
| `convert.csv_to_json` | `csv2json` | Not descriptive enough |
| `text.word_count` | `utils.count` | Too vague — what does it count? |
| `geo.reverse_lookup` | `geo.getAddressFromLatLong` | camelCase — use snake_case |

## Quality Checklist (Before Saving)

- [ ] **Tested with real data** — not just "it should work"
- [ ] **Error handling** — what happens with bad input? Empty input? Network down?
- [ ] **Clear description** — another persona reading the description knows exactly what this does
- [ ] **Accurate inputSchema** — every parameter documented with type and description
- [ ] **No hardcoded data** — everything parameterized via inputSchema
- [ ] **No side effects** (unless that's the purpose) — tools should be predictable

## What NOT to Create

- **One-off tasks** — "Convert this specific file" → just convert it
- **Duplicates** — Check `tools.list_tools` first
- **Overly complex tools** — If it needs 200+ lines, it's an application, not a tool
- **Tools with hardcoded paths/values** — Parameterize everything
- **Tools that require paid APIs without user consent** — Always discuss costs first
