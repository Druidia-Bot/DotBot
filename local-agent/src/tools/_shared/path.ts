/**
 * Path resolution and known folders.
 */

import { execSync } from "child_process";
import { resolve } from "path";

export const knownFolders: Record<string, string> = {};

function initKnownFolders(): void {
  try {
    const script = ["Desktop", "MyDocuments", "UserProfile"]
      .map(f => `[Environment]::GetFolderPath('${f}')`)
      .join(";");
    const result = execSync(
      `powershell -NoProfile -NonInteractive -Command "${script}"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    const paths = result.split(/\r?\n/);
    if (paths[0]) knownFolders["desktop"] = paths[0];
    if (paths[1]) knownFolders["documents"] = paths[1];
    if (paths[2]) knownFolders["userprofile"] = paths[2];
    const profile = knownFolders["userprofile"] || process.env.USERPROFILE || "";
    if (profile) knownFolders["downloads"] = resolve(profile, "Downloads");
  } catch {
    const profile = process.env.USERPROFILE || "";
    knownFolders["desktop"] = resolve(profile, "Desktop");
    knownFolders["documents"] = resolve(profile, "Documents");
    knownFolders["downloads"] = resolve(profile, "Downloads");
    knownFolders["userprofile"] = profile;
  }
}

initKnownFolders();

export function resolvePath(inputPath: string): string {
  let p = inputPath.replace(/\//g, "\\");
  if (p.startsWith("~\\") || p.startsWith("~/") || p === "~") {
    const rest = p.substring(2);
    const firstSegment = rest.split("\\")[0]?.toLowerCase() || "";
    if (firstSegment && knownFolders[firstSegment]) {
      return knownFolders[firstSegment] + rest.substring(firstSegment.length);
    }
    const profile = knownFolders["userprofile"] || process.env.USERPROFILE || "";
    return profile + "\\" + rest;
  }
  return p;
}
