/**
 * Local LLM Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";

export async function handleLocalLLM(_toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  const prompt = args.prompt as string;
  if (!prompt) {
    return { success: false, output: "", error: "Missing required 'prompt' parameter" };
  }

  try {
    const { queryLocalLLM } = await import("../../llm/local-llm.js");
    const maxTokens = Math.min(Number(args.max_tokens) || 512, 2048);
    const system = args.system ? String(args.system) : undefined;
    const response = await queryLocalLLM(prompt, system, maxTokens);
    return { success: true, output: response };
  } catch (err) {
    return { success: false, output: "", error: `Local LLM error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
