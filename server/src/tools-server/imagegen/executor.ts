/**
 * Image Generation Executor
 *
 * Main dispatcher for imagegen tool calls.
 * Uses IImageClient from the LLM provider layer — model selection and
 * runtime fallback are handled by createResilientImageClient().
 * This file only handles tool arg validation and agent bridge I/O.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { createResilientImageClient } from "#llm/factory.js";
import type { IImageClient } from "#llm/types.js";
import type { ImageGenResult, ExecuteCommandFn, ImageData } from "./types.js";
import type { ExecutionCommand } from "../../types.js";

const log = createComponentLogger("imagegen");

// ============================================
// MAIN EXECUTOR
// ============================================

export async function executeImageGenTool(
  toolId: string,
  args: Record<string, any>,
  executeCommand: ExecuteCommandFn,
  tempDir?: string
): Promise<ImageGenResult> {
  let client: IImageClient;
  try {
    client = createResilientImageClient();
  } catch (error) {
    return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
  }

  switch (toolId) {
    case "imagegen.generate":
      return handleGenerate(client, args, executeCommand, tempDir);
    case "imagegen.edit":
      return handleEdit(client, args, executeCommand, tempDir);
    default:
      return { success: false, output: "", error: `Unknown imagegen tool: ${toolId}` };
  }
}

// ============================================
// GENERATE (text-to-image)
// ============================================

async function handleGenerate(
  client: IImageClient,
  args: Record<string, any>,
  executeCommand: ExecuteCommandFn,
  tempDir?: string
): Promise<ImageGenResult> {
  const prompt = args.prompt;
  if (!prompt) return { success: false, output: "", error: "prompt is required" };

  const aspectRatio = args.aspect_ratio || "1:1";
  const savePath = args.save_path || `~/Downloads/generated_${Date.now()}.png`;
  const referenceImages = await loadReferenceImages(args.reference_images, executeCommand);

  log.info(`Generating image`, { provider: client.provider, promptLength: prompt.length, aspectRatio, refs: referenceImages.length });

  try {
    const result = await client.generate({
      prompt,
      aspectRatio,
      size: args.size,
      referenceImages,
    });

    const savedPath = await saveImageToAgent(result.base64, result.mimeType, savePath, executeCommand, tempDir);
    if (!savedPath) return { success: false, output: "", error: "Failed to save generated image to user's machine" };

    const desc = result.description ? `\nDescription: ${result.description}` : "";
    return {
      success: true,
      output: `Image generated and saved to: ${savedPath}\nProvider: ${client.provider}\nAspect ratio: ${aspectRatio}${desc}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("Image generation failed", { error: msg });
    return { success: false, output: "", error: `Image generation failed: ${msg}` };
  }
}

// ============================================
// EDIT (image-to-image)
// ============================================

async function handleEdit(
  client: IImageClient,
  args: Record<string, any>,
  executeCommand: ExecuteCommandFn,
  tempDir?: string
): Promise<ImageGenResult> {
  const prompt = args.prompt;
  const imagePath = args.image_path;
  if (!prompt) return { success: false, output: "", error: "prompt is required" };
  if (!imagePath) return { success: false, output: "", error: "image_path is required" };

  const sourceImage = await readImageFromAgent(imagePath, executeCommand);
  if (!sourceImage) return { success: false, output: "", error: `Could not read image at: ${imagePath}` };

  const referenceImages = await loadReferenceImages(args.reference_images, executeCommand);
  const savePath = args.save_path || imagePath.replace(/(\.\w+)$/, `_edited_${Date.now()}$1`);
  const aspectRatio = args.aspect_ratio || "";

  log.info(`Editing image`, { provider: client.provider, promptLength: prompt.length, imagePath, refs: referenceImages.length });

  try {
    const result = await client.edit({
      prompt,
      sourceImage,
      aspectRatio,
      size: args.size,
      referenceImages,
    });

    const savedPath = await saveImageToAgent(result.base64, result.mimeType, savePath, executeCommand, tempDir);
    if (!savedPath) return { success: false, output: "", error: "Failed to save edited image to user's machine" };

    const desc = result.description ? `\nDescription: ${result.description}` : "";
    return {
      success: true,
      output: `Image edited and saved to: ${savedPath}\nProvider: ${client.provider}${desc}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("Image edit failed", { error: msg });
    return { success: false, output: "", error: `Image editing failed: ${msg}` };
  }
}

// ============================================
// AGENT BRIDGE — Image Read/Write via Local Agent
// ============================================

/**
 * Load reference images from the user's machine.
 */
async function loadReferenceImages(
  refs: Array<{ path: string }> | undefined,
  executeCommand: ExecuteCommandFn
): Promise<ImageData[]> {
  const images: ImageData[] = [];
  if (!refs?.length) return images;

  for (const ref of refs.slice(0, 5)) {
    try {
      const imgData = await readImageFromAgent(ref.path, executeCommand);
      if (imgData) images.push(imgData);
    } catch (err) {
      log.warn(`Failed to load reference image: ${ref.path}`, { error: err });
    }
  }
  return images;
}

/**
 * Read an image file from the user's machine via the execution bridge.
 * Returns base64 data and mime type.
 */
async function readImageFromAgent(
  path: string,
  executeCommand: ExecuteCommandFn
): Promise<ImageData | null> {
  try {
    const command: ExecutionCommand = {
      id: `cmd_${nanoid(12)}`,
      type: "powershell",
      payload: {
        script: `$bytes = [System.IO.File]::ReadAllBytes('${path.replace(/'/g, "''")}'); [Convert]::ToBase64String($bytes)`,
      },
      dryRun: false,
      timeout: 30_000,
      sandboxed: false,
      requiresApproval: false,
    };

    const base64Data = await executeCommand(command);
    if (!base64Data || base64Data.length < 100) {
      log.warn(`Image read returned insufficient data for: ${path}`);
      return null;
    }

    const ext = path.toLowerCase().split(".").pop() || "png";
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      svg: "image/svg+xml",
    };

    return {
      mimeType: mimeMap[ext] || "image/png",
      data: base64Data.trim(),
    };
  } catch (error) {
    log.error(`Failed to read image from agent: ${path}`, { error });
    return null;
  }
}

/**
 * Save a base64 image to the user's machine via the execution bridge.
 * Uses a two-step approach: write base64 to temp file, then decode to binary.
 * This avoids Windows' ~32K CreateProcess command-line limit.
 */
async function saveImageToAgent(
  base64Data: string,
  mimeType: string,
  savePath: string,
  executeCommand: ExecuteCommandFn,
  tempDir?: string
): Promise<string | null> {
  try {
    const extMap: Record<string, string> = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
    };
    const ext = extMap[mimeType] || ".png";

    let finalPath = savePath;
    if (!finalPath.match(/\.\w+$/)) {
      finalPath += ext;
    }

    const tempFileName = `dotbot_img_${nanoid(8)}.b64`;
    const tempBase = tempDir || "~/.bot/temp";
    const tempPath = `${tempBase}/${tempFileName}`;

    log.info(`Writing ${base64Data.length} chars base64 to temp file`, { tempPath });

    // Step 1: Write base64 string to temp file
    const writeCommand: ExecutionCommand = {
      id: `cmd_${nanoid(12)}`,
      type: "file_write",
      payload: {
        path: tempPath,
        content: base64Data,
      },
      dryRun: false,
      timeout: 60_000,
      sandboxed: false,
      requiresApproval: false,
    };
    await executeCommand(writeCommand);

    // Step 2: Decode base64 temp file → binary image
    const escapedFinal = finalPath.replace(/'/g, "''");
    const escapedTemp = tempPath.replace(/'/g, "''");
    const decodeCommand: ExecutionCommand = {
      id: `cmd_${nanoid(12)}`,
      type: "powershell",
      payload: {
        script: [
          `$b64File = '${escapedTemp}'`,
          `if ($b64File.StartsWith('~')) { $b64File = $b64File.Replace('~', $env:USERPROFILE) }`,
          `$dir = Split-Path '${escapedFinal}' -Parent`,
          `if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }`,
          `$b64 = [System.IO.File]::ReadAllText($b64File)`,
          `[System.IO.File]::WriteAllBytes('${escapedFinal}', [Convert]::FromBase64String($b64))`,
          `Remove-Item $b64File -ErrorAction SilentlyContinue`,
          `Write-Output '${escapedFinal}'`,
        ].join("; "),
      },
      dryRun: false,
      timeout: 60_000,
      sandboxed: false,
      requiresApproval: false,
    };
    await executeCommand(decodeCommand);

    log.info(`Image saved to: ${finalPath}`);
    return finalPath;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : JSON.stringify(error);
    log.error("Failed to save image to agent", { error: errMsg });
    return null;
  }
}
