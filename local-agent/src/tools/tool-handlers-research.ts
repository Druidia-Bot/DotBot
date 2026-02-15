/**
 * Tool Handlers — Research
 *
 * Structured research output tools for agent workspaces.
 * Saves research notes + executive summaries with frontmatter metadata.
 */

import { promises as fs } from "fs";
import { join, basename } from "path";
import type { ToolExecResult } from "./tool-executor.js";

// ============================================
// MAIN DISPATCHER
// ============================================

export async function handleResearch(
  toolId: string,
  args: Record<string, any>,
): Promise<ToolExecResult> {
  switch (toolId) {
    case "research.save":
      return researchSave(args);
    case "research.list":
      return researchList(args);
    default:
      return { success: false, output: "", error: `Unknown research tool: ${toolId}` };
  }
}

// ============================================
// research.save
// ============================================

async function researchSave(args: Record<string, any>): Promise<ToolExecResult> {
  const workspace = args.workspace as string;
  const title = args.title as string;
  const detailedNotes = args.detailed_notes as string;

  if (!workspace) return { success: false, output: "", error: "workspace is required" };
  if (!title) return { success: false, output: "", error: "title is required" };
  if (!detailedNotes) return { success: false, output: "", error: "detailed_notes is required" };

  const type = (args.type as string) || "general-research";
  const executiveSummary = (args.executive_summary as string) || "";
  const tags = (args.tags as string[]) || [];
  const metadata = args.metadata || {};

  // Build slug from title
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  const date = new Date().toISOString().slice(0, 10);
  const timestamp = new Date().toISOString();

  // Ensure directories exist
  const researchDir = join(workspace, "research");
  const outputDir = join(workspace, "output");
  await fs.mkdir(researchDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  // Build frontmatter
  const frontmatter = [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `type: ${type}`,
    `date: ${date}`,
    `timestamp: ${timestamp}`,
    tags.length > 0 ? `tags: [${tags.map(t => `"${t}"`).join(", ")}]` : null,
    Object.keys(metadata).length > 0 ? `metadata: ${JSON.stringify(metadata)}` : null,
    "---",
  ].filter(Boolean).join("\n");

  // Save detailed research notes
  const researchFilename = `${slug}-${date}.md`;
  const researchPath = join(researchDir, researchFilename);
  const researchContent = `${frontmatter}\n\n${detailedNotes}`;
  await fs.writeFile(researchPath, researchContent, "utf-8");

  const saved: string[] = [`research/${researchFilename}`];

  // Save executive summary if provided
  if (executiveSummary) {
    const summaryPath = join(outputDir, "report.md");
    const summaryContent = `${frontmatter}\n\n# ${title}\n\n${executiveSummary}`;
    await fs.writeFile(summaryPath, summaryContent, "utf-8");
    saved.push("output/report.md");
  }

  return {
    success: true,
    output: `Research saved:\n${saved.map(f => `  → ${f}`).join("\n")}\n\nWorkspace: ${workspace}`,
  };
}

// ============================================
// research.list
// ============================================

async function researchList(args: Record<string, any>): Promise<ToolExecResult> {
  const workspace = args.workspace as string;
  if (!workspace) return { success: false, output: "", error: "workspace is required" };

  const researchDir = join(workspace, "research");

  try {
    await fs.access(researchDir);
  } catch {
    return { success: true, output: "No research directory found. No previous research exists." };
  }

  const entries = await fs.readdir(researchDir);
  const mdFiles = entries.filter(f => f.endsWith(".md")).sort();

  if (mdFiles.length === 0) {
    return { success: true, output: "Research directory exists but contains no research files." };
  }

  const summaries: string[] = [];
  for (const file of mdFiles) {
    const filePath = join(researchDir, file);
    const content = await fs.readFile(filePath, "utf-8");

    // Parse frontmatter
    let title = basename(file, ".md");
    let type = "";
    let date = "";
    let tags: string[] = [];

    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const titleMatch = fm.match(/title:\s*"?([^"\n]+)"?/);
      const typeMatch = fm.match(/type:\s*(\S+)/);
      const dateMatch = fm.match(/date:\s*(\S+)/);
      const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
      if (titleMatch) title = titleMatch[1];
      if (typeMatch) type = typeMatch[1];
      if (dateMatch) date = dateMatch[1];
      if (tagsMatch) tags = tagsMatch[1].split(",").map(t => t.trim().replace(/"/g, ""));
    }

    // Get file size
    const stat = await fs.stat(filePath);
    const sizeKB = (stat.size / 1024).toFixed(1);

    summaries.push(
      `- **${title}**\n  File: research/${file} (${sizeKB} KB)\n` +
      (type ? `  Type: ${type}\n` : "") +
      (date ? `  Date: ${date}\n` : "") +
      (tags.length > 0 ? `  Tags: ${tags.join(", ")}\n` : ""),
    );
  }

  // Also check for executive summary
  const reportPath = join(workspace, "output", "report.md");
  let hasReport = false;
  try {
    await fs.access(reportPath);
    hasReport = true;
  } catch { /* no report */ }

  let output = `Found ${mdFiles.length} research file(s):\n\n${summaries.join("\n")}`;
  if (hasReport) output += `\nExecutive summary available at: output/report.md`;

  return { success: true, output };
}
