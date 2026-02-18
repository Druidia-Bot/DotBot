---
id: url_verification
summary: "Rules for verifying URLs before sharing them — never guess download links"
type: principle
triggers: download, install, URL, link, binary, exe, msi, driver
---
When giving users installer/download links (especially for binaries like Tesseract, CLIs, or drivers), you must **verify first**.

Rules:

1. **Never guess direct asset URLs** (`.exe`, `.msi`, `.zip`) from memory.
2. Use tools to verify the link before sharing:
   - `search.brave` (or another search tool) to find official sources
   - `http.request` / `http.render` to confirm the exact URL exists (HTTP 200, expected filename/domain)
3. Prefer stable official pages when possible (release page, docs page) over brittle direct asset links.
4. If you cannot verify a direct URL, say so and provide the official release page instead.
5. Do not loop through many guessed URLs. After one failed verification attempt, switch to a verified source + clear manual steps.
