/**
 * Core Tool Definitions
 * 
 * Built-in tools that ship with the local agent. These are always available
 * and cover fundamental capabilities: filesystem, shell, http, etc.
 * 
 * Each tool follows the DotBotTool interface (extends MCP Tool).
 * Definitions are organized by category in individual directories.
 */

import type { DotBotTool } from "../memory/types.js";

// Category definitions — one file per category
import { filesystemTools } from "./filesystem/defs.js";
import { directoryTools } from "./directory/defs.js";
import { shellTools } from "./shell/defs.js";
import { httpTools } from "./http/defs.js";
import { clipboardTools } from "./clipboard/defs.js";
import { browserTools } from "./browser/defs.js";
import { systemTools } from "./system/defs.js";
import { networkTools } from "./network/defs.js";
import { secretsTools } from "./secrets/defs.js";
import { searchTools } from "./search/defs.js";
import { toolsManagementTools } from "./tools-manage/defs.js";
import { skillsManagementTools } from "./skills/defs.js";
import { codegenTools } from "./codegen/defs.js";
import { npmTools } from "./npm/defs.js";
import { gitTools } from "./git/defs.js";
import { runtimeTools } from "./runtime/defs.js";
import { knowledgeTools } from "./knowledge/defs.js";
import { personaTools } from "./personas/defs.js";
import { llmTools } from "./llm/defs.js";
import { discordTools } from "./discord/defs.js";
import { reminderTools } from "./reminder/defs.js";
import { adminTools } from "./admin/defs.js";
import { emailTools } from "./email/defs.js";
import { marketTools } from "./market/defs.js";
import { onboardingTools } from "./onboarding/defs.js";
import { researchTools } from "./research/defs.js";
import { guiTools } from "./gui/index.js";
import { registryTools } from "./registry/defs.js";
import { windowTools } from "./window/defs.js";
import { screenTools } from "./screen/defs.js";
import { audioTools } from "./audio/defs.js";
import { monitoringTools } from "./monitoring/defs.js";
import { packageTools } from "./package/defs.js";
import { dataTools } from "./data/defs.js";
import { pdfTools } from "./pdf/defs.js";
import { dbTools } from "./db/defs.js";
import { visionTools } from "./vision/defs.js";

// ============================================
// EXPORT ALL CORE TOOLS
// ============================================

export const CORE_TOOLS: DotBotTool[] = [
  ...filesystemTools,
  ...directoryTools,
  ...shellTools,
  ...httpTools,
  ...clipboardTools,
  ...browserTools,
  ...systemTools,
  ...networkTools,
  ...secretsTools,
  ...searchTools,
  ...toolsManagementTools,
  ...skillsManagementTools,
  ...codegenTools,
  ...npmTools,
  ...gitTools,
  ...runtimeTools,
  ...knowledgeTools,
  ...personaTools,
  ...llmTools,
  ...discordTools,
  ...reminderTools,
  ...adminTools,
  ...emailTools,
  ...marketTools,
  ...onboardingTools,
  ...researchTools,
  ...guiTools,
  ...registryTools,
  ...windowTools,
  ...screenTools,
  ...audioTools,
  ...monitoringTools,
  ...packageTools,
  ...dataTools,
  ...pdfTools,
  ...dbTools,
  ...visionTools,
];

/**
 * Get core tools by category.
 */
export function getCoreToolsByCategory(category: string): DotBotTool[] {
  return CORE_TOOLS.filter(t => t.category === category);
}

/**
 * Get a specific core tool by ID.
 */
export function getCoreTool(id: string): DotBotTool | undefined {
  return CORE_TOOLS.find(t => t.id === id);
}
