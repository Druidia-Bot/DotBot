/**
 * DEPRECATED — Re-exports from category handler files.
 * Import directly from secrets/handler, tools-manage/handler, skills/handler instead.
 */

export { handleSecrets } from "./secrets/handler.js";
export { handleToolsManagement } from "./tools-manage/handler.js";
export { handleSkillsManagement } from "./skills/handler.js";
export { knownFolders } from "./_shared/path.js";
