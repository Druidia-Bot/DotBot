/**
 * Research Artifact Tools
 *
 * Server-side tools for saving research output to agent workspace files.
 * Generates file.write commands that are sent to the local agent for execution.
 */

import { createComponentLogger } from "../logging.js";
import type { ExecutionCommand } from "../types.js";

const log = createComponentLogger("research-tools");

// ============================================
// TYPES
// ============================================

export interface ResearchToolResult {
  success: boolean;
  output: string;
  error?: string;
}

interface ResearchArtifact {
  title: string;
  type: "market-analysis" | "news-summary" | "general-research" | "competitive-analysis";
  detailedNotes: string;
  executiveSummary: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ============================================
// MAIN EXECUTOR
// ============================================

/**
 * Execute a research.* tool call server-side.
 * Generates file.write commands for the client to execute in the agent workspace.
 */
export async function executeResearchTool(
  agentId: string,
  toolId: string,
  args: Record<string, any>,
  executeCommand: (cmd: ExecutionCommand) => Promise<string>
): Promise<ResearchToolResult> {
  try {
    switch (toolId) {
      case "research.save":
        return await handleSave(agentId, args, executeCommand);
      case "research.list":
        return await handleList(agentId, executeCommand);
      default:
        return { success: false, output: "", error: `Unknown research tool: ${toolId}` };
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("Research tool error", { toolId, error: errMsg });
    return { success: false, output: "", error: errMsg };
  }
}

// ============================================
// HANDLERS
// ============================================

async function handleList(
  agentId: string,
  executeCommand: (cmd: ExecutionCommand) => Promise<string>
): Promise<ResearchToolResult> {
  const workspaceBase = `~/.bot/agent-workspaces/${agentId}`;
  const researchPath = `${workspaceBase}/workspace/research`;

  try {
    // List all files in research directory
    const listResult = await executeCommand({
      id: `list_research_${Date.now()}`,
      type: "tool_execute",
      payload: {
        toolId: "directory.list",
        toolArgs: { path: researchPath },
      },
      dryRun: false,
      timeout: 10000,
      sandboxed: false,
      requiresApproval: false,
    });

    // Parse the directory listing
    const files = listResult.split("\n").filter(f => f.trim() && f.endsWith(".md"));

    if (files.length === 0) {
      return {
        success: true,
        output: "No previous research found in workspace. This is your first research task.",
      };
    }

    // Read frontmatter from each file to get metadata
    const fileDetails: Array<{ filename: string; title?: string; type?: string; date?: string; tags?: string[] }> = [];

    for (const filename of files.slice(0, 10)) {  // Limit to 10 most recent
      try {
        const content = await executeCommand({
          id: `read_research_${Date.now()}`,
          type: "tool_execute",
          payload: {
            toolId: "file.read",
            toolArgs: { path: `${researchPath}/${filename}` },
          },
          dryRun: false,
          timeout: 10000,
          sandboxed: false,
          requiresApproval: false,
        });

        // Extract frontmatter (simple regex)
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (frontmatterMatch) {
          const frontmatter = frontmatterMatch[1];
          const titleMatch = frontmatter.match(/title: "(.+?)"/);
          const typeMatch = frontmatter.match(/type: (.+)/);
          const dateMatch = frontmatter.match(/date: (.+)/);
          const tagsMatch = frontmatter.match(/tags: \[(.*?)\]/);

          fileDetails.push({
            filename,
            title: titleMatch?.[1],
            type: typeMatch?.[1],
            date: dateMatch?.[1],
            tags: tagsMatch?.[1]?.split(",").map(t => t.trim().replace(/"/g, "")),
          });
        } else {
          fileDetails.push({ filename });
        }
      } catch {
        fileDetails.push({ filename });
      }
    }

    // Format output
    const output = [
      `Found ${files.length} previous research file(s) in workspace:\n`,
      ...fileDetails.map((f, i) => {
        const parts = [`${i + 1}. **${f.title || f.filename}**`];
        if (f.type) parts.push(`(${f.type})`);
        if (f.date) parts.push(`- ${new Date(f.date).toLocaleDateString()}`);
        if (f.tags?.length) parts.push(`[${f.tags.join(", ")}]`);
        parts.push(`\n   File: workspace/research/${f.filename}`);
        return parts.join(" ");
      }),
      `\nUse file.read to view full content of any research file before starting new research.`,
    ].join("\n");

    return { success: true, output };
  } catch (error) {
    // Directory might not exist yet - that's OK
    if (error && String(error).includes("does not exist")) {
      return {
        success: true,
        output: "No previous research found. Workspace research directory will be created when you save your first research.",
      };
    }
    throw error;
  }
}

async function handleSave(
  agentId: string,
  args: Record<string, any>,
  executeCommand: (cmd: ExecutionCommand) => Promise<string>
): Promise<ResearchToolResult> {
  const { title, type, detailedNotes, executiveSummary, tags, metadata } = args;

  if (!title || !type || !detailedNotes || !executiveSummary) {
    return {
      success: false,
      output: "",
      error: "title, type, detailedNotes, and executiveSummary are required"
    };
  }

  const artifact: ResearchArtifact = {
    title,
    type,
    detailedNotes,
    executiveSummary,
    tags,
    metadata,
  };

  log.info("Saving research artifact", {
    agentId,
    title: artifact.title,
    type: artifact.type,
  });

  // Generate filename with ISO date
  const dateStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const slug = artifact.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const researchFilename = `${slug}-${dateStr}.md`;

  const workspaceBase = `~/.bot/agent-workspaces/${agentId}`;
  const researchPath = `${workspaceBase}/workspace/research`;
  const outputPath = `${workspaceBase}/workspace/output`;

  // Build frontmatter
  const frontmatter = [
    "---",
    `title: "${artifact.title}"`,
    `type: ${artifact.type}`,
    `date: ${new Date().toISOString()}`,
    `tags: [${(artifact.tags || []).map(t => `"${t}"`).join(", ")}]`,
  ];

  if (artifact.metadata) {
    Object.entries(artifact.metadata).forEach(([key, value]) => {
      frontmatter.push(`${key}: ${JSON.stringify(value)}`);
    });
  }

  frontmatter.push("---", "");

  // Build detailed research content
  const researchContent = [
    ...frontmatter,
    `# ${artifact.title}`,
    "",
    artifact.detailedNotes,
    "",
    "---",
    "",
    `*Research completed: ${new Date().toISOString()}*`,
    `*Agent: ${agentId}*`,
  ].join("\n");

  // Build executive summary
  const reportHeader = `# Research Report\n\n*Generated: ${new Date().toISOString()}*\n\n---\n\n`;
  const reportSection = `## ${artifact.title}\n\n${artifact.executiveSummary}\n\n---\n\n`;
  const reportContent = reportHeader + reportSection;

  try {
    // Create research directory if it doesn't exist
    await executeCommand({
      id: `mkdir_research_${Date.now()}`,
      type: "tool_execute",
      payload: {
        toolId: "directory.create",
        toolArgs: { path: researchPath, recursive: true },
      },
      dryRun: false,
      timeout: 10000,
      sandboxed: false,
      requiresApproval: false,
    });

    // Create output directory if it doesn't exist
    await executeCommand({
      id: `mkdir_output_${Date.now()}`,
      type: "tool_execute",
      payload: {
        toolId: "directory.create",
        toolArgs: { path: outputPath, recursive: true },
      },
      dryRun: false,
      timeout: 10000,
      sandboxed: false,
      requiresApproval: false,
    });

    // Write detailed research file
    await executeCommand({
      id: `write_research_${Date.now()}`,
      type: "tool_execute",
      payload: {
        toolId: "file.write",
        toolArgs: {
          path: `${researchPath}/${researchFilename}`,
          content: researchContent,
        },
      },
      dryRun: false,
      timeout: 15000,
      sandboxed: false,
      requiresApproval: false,
    });

    // Write executive summary
    await executeCommand({
      id: `write_report_${Date.now()}`,
      type: "tool_execute",
      payload: {
        toolId: "file.write",
        toolArgs: {
          path: `${outputPath}/report.md`,
          content: reportContent,
        },
      },
      dryRun: false,
      timeout: 10000,
      sandboxed: false,
      requiresApproval: false,
    });

    log.info("Research artifact saved", {
      agentId,
      researchFile: researchFilename,
    });

    return {
      success: true,
      output: `Research saved successfully:\n- Detailed notes: workspace/research/${researchFilename}\n- Executive summary: workspace/output/report.md\n\nWorkspace persists for 24 hours after agent completion.`,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("Failed to write research files", { agentId, error: errMsg });
    return {
      success: false,
      output: "",
      error: `Failed to write research files: ${errMsg}`,
    };
  }
}
