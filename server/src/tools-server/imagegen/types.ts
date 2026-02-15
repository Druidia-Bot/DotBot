/**
 * Image Generation Types & Constants
 */

import type { ExecutionCommand } from "../../types.js";

export interface ImageGenResult {
  success: boolean;
  output: string;
  error?: string;
}

export type ExecuteCommandFn = (command: ExecutionCommand) => Promise<string>;

export interface ImageData {
  mimeType: string;
  data: string;
}
