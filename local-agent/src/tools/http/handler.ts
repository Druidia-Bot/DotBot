/**
 * HTTP Tool Handler
 */

import { promises as fs } from "fs";
import { dirname } from "path";
import type { ToolExecResult } from "../_shared/types.js";
import { resolvePath } from "../_shared/path.js";
import { isAllowedUrl } from "../_shared/powershell.js";
import { isAllowedWrite } from "../_shared/security.js";
import { safeInt } from "../_shared/powershell.js";

export async function handleHttp(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "http.render": {
      if (!args.url) {
        return { success: false, output: "", error: "URL is required" };
      }
      // Lazy import to avoid loading Playwright until needed
      const { headlessBridge } = await import("../gui/headless-bridge.js");
      try {
        // Navigate using the browser bridge (handles URL sanitization + bot challenge detection)
        const navResult = await headlessBridge.navigate({ url: args.url });

        // Wait extra time for JS frameworks to finish rendering
        const waitMs = Math.min(Math.max(args.wait_ms || 2000, 0), 15000);
        await new Promise(resolve => setTimeout(resolve, waitMs));

        // Read the rendered page state (ARIA snapshot = full rendered text)
        const stateJson = await headlessBridge.readState({});
        let state: any;
        try { state = JSON.parse(stateJson); } catch { state = {}; }

        // Extract clean text content from the page
        const page = await headlessBridge.getActivePage();
        const textContent = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
        const truncated = textContent.length > 80_000
          ? textContent.substring(0, 80_000) + "\n...[truncated at 80K chars]"
          : textContent;

        return {
          success: true,
          output: JSON.stringify({
            url: state.url || args.url,
            title: state.title || "",
            rendered_text: truncated,
            aria_snapshot: state.aria_snapshot || "",
            char_count: textContent.length,
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: `Browser render failed: ${err.message || String(err)}` };
      }
    }
    case "http.request": {
      if (!args.url || !isAllowedUrl(args.url)) {
        return { success: false, output: "", error: "URL must be http/https to a public host (no localhost, private IPs, or cloud metadata)" };
      }
      const method = (args.method || "GET").toUpperCase();
      const timeout = safeInt(args.timeout, 30_000);
      const headers: Record<string, string> = args.headers || {};
      if (args.auth) headers["Authorization"] = args.auth;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const fetchOpts: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };
        if (args.body && ["POST", "PUT", "PATCH"].includes(method)) {
          fetchOpts.body = args.body;
          if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
        }

        const response = await fetch(args.url, fetchOpts);
        clearTimeout(timer);

        const text = await response.text();
        const truncated = text.length > 50_000 ? text.substring(0, 50_000) + "\n...[truncated]" : text;

        return {
          success: response.ok,
          output: `HTTP ${response.status} ${response.statusText}\n\n${truncated}`,
          error: response.ok ? undefined : `HTTP ${response.status}`,
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message || String(err) };
      }
    }
    case "http.download": {
      if (!args.url || !isAllowedUrl(args.url)) {
        return { success: false, output: "", error: "URL must be http/https to a public host (no localhost, private IPs, or cloud metadata)" };
      }
      const destPath = resolvePath(args.path);
      if (!isAllowedWrite(destPath)) return { success: false, output: "", error: `Write access denied: ${destPath}` };

      try {
        const response = await fetch(args.url);
        if (!response.ok) return { success: false, output: "", error: `HTTP ${response.status}` };

        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.mkdir(dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, buffer);
        return { success: true, output: `Downloaded ${buffer.length} bytes to ${destPath}` };
      } catch (err: any) {
        return { success: false, output: "", error: err.message || String(err) };
      }
    }
    default:
      return { success: false, output: "", error: `Unknown http tool: ${toolId}` };
  }
}
