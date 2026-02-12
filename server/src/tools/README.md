# Core Tool Registry

**Organization:** Tools are now organized by platform for better manageability.

## File Structure

```
server/src/tools/
├── core-registry.ts       # Main registry (imports & exports)
├── platform-filters.ts    # Platform/runtime filtering logic
├── definitions/
│   ├── windows-only.ts    # Windows-specific tools (43 tools)
│   ├── cross-platform.ts  # Desktop tools - Win/Linux/macOS (123 tools)
│   └── universal.ts       # All platforms including web (8 tools)
```

## Tool Distribution

**Total: 174 tools across 37 categories**

### By Platform
- **Windows-only (WIN):** 43 tools
  - Registry operations (4)
  - Window management (6)
  - Audio control (4)
  - Performance monitoring (4)
  - Package management (4)
  - Windows-specific: system, filesystem, directory, shell, network, clipboard, browser, search

- **Cross-platform Desktop (DESKTOP):** 123 tools
  - Filesystem (15), Directory (3), Data (6), PDF (4), Database (4), Vision (3)
  - Shell (4), HTTP (3), System (5), Secrets (3), Search (4)
  - Tools (3), Skills (4), Codegen (2), Runtime (2), NPM (1), Git (1)
  - Knowledge (5), Personas (3), LLM (1), Discord (12), Reminder (3)
  - Admin (5), Market (8), Email (5), Onboarding (4), GUI (10)

- **Universal (ALL):** 8 tools (server-executed)
  - Knowledge ingest (1), Schedule (5), Research (2)

### By Category

**Windows-Only Categories:**
- `registry` - Windows registry operations
- `window` - Window management & screen capture
- `audio` - System audio control
- `monitoring` - Performance tracking
- `package` - winget/chocolatey package management

**Cross-Platform Categories:**
- `data` - CSV/Excel/JSON/XML processing
- `pdf` - PDF operations
- `database` - SQLite operations
- `vision` - OCR & image analysis
- `filesystem`, `directory` - File operations
- `shell`, `http`, `system`, `network` - System operations
- `secrets`, `search`, `tools`, `skills` - Core functionality
- `codegen`, `runtime`, `npm`, `git` - Development tools
- `knowledge`, `personas`, `llm` - AI/memory
- `discord`, `email` - Communication
- `reminder`, `schedule` - Task management
- `admin`, `market` - Administrative & market data
- `onboarding`, `gui` - Setup & automation

**Universal Categories:**
- `knowledge` - Server-executed knowledge ingest
- `schedule` - Server-side recurring tasks
- `research` - Research workspace management

## Usage

```typescript
import { CORE_TOOLS, getCoreToolById, getCoreToolsByPlatform, getPlatformStats } from "./core-registry.js";

// Get all tools
const allTools = CORE_TOOLS; // 174 tools

// Get by platform
const windowsTools = getCoreToolsByPlatform("windows");

// Get platform stats
const stats = getPlatformStats();
// { windows: 43, crossPlatform: 123, universal: 8, total: 174 }

// Get specific tool
const tool = getCoreToolById("registry.read");
```

## Adding New Tools

1. **Determine platform scope:**
   - Windows-only? → `definitions/windows-only.ts`
   - Cross-platform desktop? → `definitions/cross-platform.ts`
   - Universal (server-executed)? → `definitions/universal.ts`

2. **Add tool definition:**
   ```typescript
   {
     id: "category.action",
     name: "tool_name",
     description: "What it does",
     category: "category",
     executor: "client" | "server",
     platforms: WIN | DESKTOP | ALL,
     requiredRuntimes: ["powershell", "node", etc.],
     inputSchema: { ... },
     annotations: { ... }
   }
   ```

3. **Export from category array:**
   ```typescript
   export const categoryName: CoreToolDefinition[] = [
     // ... tools
   ];
   ```

4. **Add to platform export:**
   ```typescript
   export const WINDOWS_ONLY_TOOLS = [
     ...categoryName,
     // ... other categories
   ];
   ```

## Platform Constants

- `WIN: Platform[] = ["windows"]`
- `DESKTOP: Platform[] = ["windows", "linux", "macos"]`
- `ALL: Platform[] = ["windows", "linux", "macos", "web"]`

## Benefits of This Structure

1. **Better organization** - Tools grouped by platform first, then category
2. **Easier navigation** - Smaller files (windows-only: ~250 lines, cross-platform: ~500 lines, universal: ~100 lines)
3. **Clear separation** - Windows-specific vs cross-platform vs universal
4. **Maintainability** - Changes to Windows tools don't affect cross-platform code
5. **Type safety** - Platform[] types properly enforced
6. **Scalability** - Easy to add new platform-specific tool files

---

*Last Updated: 2026-02-11*
*Total: 174 tools across 37 categories*
