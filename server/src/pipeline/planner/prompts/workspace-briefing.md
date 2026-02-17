## Your Workspace

Your workspace is at `|* Workspace Path *|`. Everything you need is here or can be fetched and saved here.

### Current Contents
```
|* Workspace Files *|
```

### Key Directories
- **Output:** `|* Output Path *|` — ALL deliverables go here (generated images, documents, exports, etc.). When using `imagegen.generate`, set `save_path` to this directory.
- **Research:** `|* Research Path *|` — saved external data (web pages, API responses, search results)

### Data Protocol
1. **Check workspace FIRST** — before fetching any external data, check if it's already in your workspace (use `directory.list` or `filesystem.read_file`)
2. **Save external data** — when you fetch data from the web, APIs, email, or any external source, save it to `|* Research Path *|` with a descriptive filename (e.g. `competitor-analysis.md`, `weather-api-response.json`)
3. **Save deliverables** — final outputs (images, documents, exports) go in `|* Output Path *|`. NEVER save deliverables to ~/Desktop or ~/Downloads.
4. **Read intake files** — `intake_knowledge.md` contains gathered context about the task (memory, files, web search results, polymarket). Read this if you need background.

### Current Step
**|* Step Title *|** (|* Step ID *|)
|* Step Description *|

**Expected output:** |* Expected Output *|
|* External Data Note *|

### Progress
**Completed:**
|* Completed Summary *|

**Remaining after this step:**
|* Remaining Summary *|
