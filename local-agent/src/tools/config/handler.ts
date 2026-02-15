/**
 * Config Tool Handlers
 *
 * General CRUD for ~/.bot/.env — the local agent's configuration file.
 * Reads, writes, lists, and deletes key=value pairs. Updates process.env
 * immediately so changes take effect without restart.
 */

import { promises as fs } from "fs";
import { resolve, dirname } from "path";
import type { ToolExecResult } from "../_shared/types.js";

function getEnvPath(): string {
  return resolve(process.env.USERPROFILE || process.env.HOME || "", ".bot", ".env");
}

/** Parse ~/.bot/.env into a Map, preserving order */
async function parseEnvFile(): Promise<Map<string, string>> {
  const envPath = getEnvPath();
  let raw = "";
  try {
    raw = await fs.readFile(envPath, "utf-8");
  } catch { /* file doesn't exist yet */ }

  const map = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      map.set(trimmed.substring(0, eqIdx).trim(), trimmed.substring(eqIdx + 1).trim());
    }
  }
  return map;
}

/** Write a Map back to ~/.bot/.env */
async function writeEnvFile(map: Map<string, string>): Promise<void> {
  const envPath = getEnvPath();
  await fs.mkdir(dirname(envPath), { recursive: true });
  const lines = Array.from(map.entries()).map(([k, v]) => `${k}=${v}`);
  await fs.writeFile(envPath, lines.join("\n") + "\n", "utf-8");
}

export async function handleConfig(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "config.get": {
      const key = args.key as string;
      if (!key) return { success: false, output: "", error: "Missing required field: key" };

      const map = await parseEnvFile();
      const value = map.get(key) ?? null;
      return { success: true, output: JSON.stringify({ key, value }) };
    }

    case "config.set": {
      const key = args.key as string;
      const value = args.value as string;
      if (!key) return { success: false, output: "", error: "Missing required field: key" };
      if (value === undefined || value === null) return { success: false, output: "", error: "Missing required field: value" };

      const map = await parseEnvFile();
      const existed = map.has(key);
      map.set(key, value);
      await writeEnvFile(map);
      process.env[key] = value;

      return {
        success: true,
        output: JSON.stringify({ key, value, action: existed ? "updated" : "created" })
      };
    }

    case "config.list": {
      const map = await parseEnvFile();
      const entries: Record<string, string> = {};
      for (const [k, v] of map) {
        entries[k] = v;
      }
      return { success: true, output: JSON.stringify({ count: map.size, entries }, null, 2) };
    }

    case "config.delete": {
      const key = args.key as string;
      if (!key) return { success: false, output: "", error: "Missing required field: key" };

      const map = await parseEnvFile();
      const existed = map.has(key);
      if (!existed) {
        return { success: true, output: JSON.stringify({ key, deleted: false, reason: "Key not found" }) };
      }
      map.delete(key);
      await writeEnvFile(map);
      delete process.env[key];

      return { success: true, output: JSON.stringify({ key, deleted: true }) };
    }

    default:
      return { success: false, output: "", error: `Unknown config tool: ${toolId}` };
  }
}
