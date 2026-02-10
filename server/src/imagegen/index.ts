/**
 * Image Generation Tools — Server-Side Execution
 * 
 * Gemini (gemini-2.5-flash-image) is the primary provider.
 * OpenAI (gpt-image-1.5) is the fallback for when Gemini won't cooperate on edits.
 * 
 * Images are generated server-side using DotBot's API keys, then saved
 * to the user's machine via the execution bridge (file_write command).
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../logging.js";
import type { ExecutionCommand } from "../types.js";

const log = createComponentLogger("imagegen");

const GEMINI_API_KEY = process.env.GOOGLE_NANO_BANANA_APIKEY || process.env.GEMINI_IMAGE_API_KEY || "";
const OPENAI_API_KEY = process.env.OPEN_AI_IMAGE_GEN_API_KEY || process.env.OPENAI_IMAGE_API_KEY || "";

export interface ImageGenResult {
  success: boolean;
  output: string;
  error?: string;
}

type ExecuteCommandFn = (command: ExecutionCommand) => Promise<string>;

// ============================================
// MAIN EXECUTOR
// ============================================

export async function executeImageGenTool(
  toolId: string,
  args: Record<string, any>,
  executeCommand: ExecuteCommandFn,
  tempDir?: string
): Promise<ImageGenResult> {
  switch (toolId) {
    case "imagegen.generate":
      return handleGenerate(args, executeCommand, tempDir);
    case "imagegen.edit":
      return handleEdit(args, executeCommand, tempDir);
    default:
      return { success: false, output: "", error: `Unknown imagegen tool: ${toolId}` };
  }
}

// ============================================
// GENERATE (text-to-image)
// ============================================

async function handleGenerate(
  args: Record<string, any>,
  executeCommand: ExecuteCommandFn,
  tempDir?: string
): Promise<ImageGenResult> {
  const prompt = args.prompt;
  if (!prompt) return { success: false, output: "", error: "prompt is required" };

  const provider = chooseProvider(args.provider, "generate");
  const aspectRatio = args.aspect_ratio || "1:1";
  const savePath = args.save_path || `~/Downloads/generated_${Date.now()}.png`;

  // Load reference images if provided
  const referenceImages: { mimeType: string; data: string }[] = [];
  if (args.reference_images?.length) {
    for (const ref of args.reference_images.slice(0, 5)) {
      try {
        const imgData = await readImageFromAgent(ref.path, executeCommand);
        if (imgData) referenceImages.push(imgData);
      } catch (err) {
        log.warn(`Failed to load reference image: ${ref.path}`, { error: err });
      }
    }
  }

  log.info(`Generating image with ${provider}`, { prompt: prompt.substring(0, 100), aspectRatio, refs: referenceImages.length });

  let result: { base64: string; mimeType: string; description?: string } | null = null;

  if (provider === "gemini") {
    if (!GEMINI_API_KEY) return { success: false, output: "", error: "Gemini API key not configured. Set GOOGLE_NANO_BANANA_APIKEY in .env" };
    result = await callGeminiGenerate(prompt, aspectRatio, referenceImages);
  } else {
    if (!OPENAI_API_KEY) return { success: false, output: "", error: "OpenAI image API key not configured. Set OPEN_AI_IMAGE_GEN_API_KEY in .env" };
    result = await callOpenAIGenerate(prompt, args.size || mapAspectToOpenAISize(aspectRatio));
  }

  if (!result) return { success: false, output: "", error: `${provider} image generation failed — no image returned` };

  // Save to user's machine via execution bridge
  const savedPath = await saveImageToAgent(result.base64, result.mimeType, savePath, executeCommand, tempDir);
  if (!savedPath) return { success: false, output: "", error: "Failed to save generated image to user's machine" };

  const desc = result.description ? `\nDescription: ${result.description}` : "";
  return {
    success: true,
    output: `Image generated and saved to: ${savedPath}\nProvider: ${provider}\nAspect ratio: ${aspectRatio}${desc}`,
  };
}

// ============================================
// EDIT (image-to-image)
// ============================================

async function handleEdit(
  args: Record<string, any>,
  executeCommand: ExecuteCommandFn,
  tempDir?: string
): Promise<ImageGenResult> {
  const prompt = args.prompt;
  const imagePath = args.image_path;
  if (!prompt) return { success: false, output: "", error: "prompt is required" };
  if (!imagePath) return { success: false, output: "", error: "image_path is required" };

  const provider = chooseProvider(args.provider, "edit");
  const aspectRatio = args.aspect_ratio || "";

  // Read the source image
  const sourceImage = await readImageFromAgent(imagePath, executeCommand);
  if (!sourceImage) return { success: false, output: "", error: `Could not read image at: ${imagePath}` };

  // Load additional reference images
  const referenceImages: { mimeType: string; data: string }[] = [];
  if (args.reference_images?.length) {
    for (const ref of args.reference_images.slice(0, 5)) {
      try {
        const imgData = await readImageFromAgent(ref.path, executeCommand);
        if (imgData) referenceImages.push(imgData);
      } catch (err) {
        log.warn(`Failed to load reference image: ${ref.path}`, { error: err });
      }
    }
  }

  // Default save path: same directory with _edited suffix
  const savePath = args.save_path || imagePath.replace(/(\.\w+)$/, `_edited_${Date.now()}$1`);

  log.info(`Editing image with ${provider}`, { prompt: prompt.substring(0, 100), imagePath, refs: referenceImages.length });

  let result: { base64: string; mimeType: string; description?: string } | null = null;

  if (provider === "gemini") {
    if (!GEMINI_API_KEY) return { success: false, output: "", error: "Gemini API key not configured. Set GOOGLE_NANO_BANANA_APIKEY in .env" };
    result = await callGeminiEdit(prompt, sourceImage, aspectRatio, referenceImages);
  } else {
    // OpenAI fallback: generate a new image with detailed prompt describing the edit
    if (!OPENAI_API_KEY) return { success: false, output: "", error: "OpenAI image API key not configured. Set OPEN_AI_IMAGE_GEN_API_KEY in .env" };
    const editPrompt = `Based on an existing image, create a new version with these changes: ${prompt}. Maintain the same overall style and composition.`;
    result = await callOpenAIGenerate(editPrompt, args.size || "1024x1024");
  }

  if (!result) return { success: false, output: "", error: `${provider} image editing failed — no image returned` };

  const savedPath = await saveImageToAgent(result.base64, result.mimeType, savePath, executeCommand, tempDir);
  if (!savedPath) return { success: false, output: "", error: "Failed to save edited image to user's machine" };

  const desc = result.description ? `\nDescription: ${result.description}` : "";
  return {
    success: true,
    output: `Image edited and saved to: ${savedPath}\nProvider: ${provider}${desc}`,
  };
}

// ============================================
// GEMINI API (Nano Banana)
// ============================================

async function callGeminiGenerate(
  prompt: string,
  aspectRatio: string,
  referenceImages: { mimeType: string; data: string }[]
): Promise<{ base64: string; mimeType: string; description?: string } | null> {
  const parts: any[] = [{ text: prompt }];

  // Add reference images as inline data
  for (const img of referenceImages) {
    parts.push({
      inline_data: { mime_type: img.mimeType, data: img.data },
    });
  }

  const body: any = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  // Add aspect ratio config
  if (aspectRatio && aspectRatio !== "1:1") {
    body.generationConfig.imageConfig = { aspectRatio };
  }

  return callGeminiAPI(body);
}

async function callGeminiEdit(
  prompt: string,
  sourceImage: { mimeType: string; data: string },
  aspectRatio: string,
  referenceImages: { mimeType: string; data: string }[]
): Promise<{ base64: string; mimeType: string; description?: string } | null> {
  const parts: any[] = [
    { text: prompt },
    { inline_data: { mime_type: sourceImage.mimeType, data: sourceImage.data } },
  ];

  for (const img of referenceImages) {
    parts.push({
      inline_data: { mime_type: img.mimeType, data: img.data },
    });
  }

  const body: any = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  if (aspectRatio) {
    body.generationConfig.imageConfig = { aspectRatio };
  }

  return callGeminiAPI(body);
}

async function callGeminiAPI(
  body: any
): Promise<{ base64: string; mimeType: string; description?: string } | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error("Gemini API error", { status: response.status, body: errorText.substring(0, 500) });
      return null;
    }

    const data = await response.json() as any;
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts) {
      log.error("Gemini response missing parts", { data: JSON.stringify(data).substring(0, 500) });
      return null;
    }

    let base64 = "";
    let mimeType = "image/png";
    let description = "";

    for (const part of candidate.content.parts) {
      if (part.text) {
        description = part.text;
      } else if (part.inlineData) {
        base64 = part.inlineData.data;
        mimeType = part.inlineData.mimeType || "image/png";
      }
    }

    if (!base64) {
      log.error("Gemini response contained no image data");
      return null;
    }

    log.info(`Gemini generated image: ${base64.length} chars base64, ${mimeType}`);
    return { base64, mimeType, description };
  } catch (error) {
    log.error("Gemini API call failed", { error });
    return null;
  }
}

// ============================================
// OPENAI API (DALL-E)
// ============================================

async function callOpenAIGenerate(
  prompt: string,
  size: string
): Promise<{ base64: string; mimeType: string; description?: string } | null> {
  try {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1.5",
        prompt,
        size: size || "auto",
        quality: "auto",
        n: 1,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error("OpenAI API error", { status: response.status, body: errorText.substring(0, 500) });
      return null;
    }

    const data = await response.json() as any;
    const imageData = data.data?.[0];
    if (!imageData?.b64_json) {
      log.error("OpenAI response missing image data");
      return null;
    }

    log.info(`OpenAI gpt-image-1.5 generated image: ${imageData.b64_json.length} chars base64`);

    return {
      base64: imageData.b64_json,
      mimeType: "image/png",
      description: imageData.revised_prompt ? `Revised prompt: ${imageData.revised_prompt}` : undefined,
    };
  } catch (error) {
    log.error("OpenAI API call failed", { error });
    return null;
  }
}

// ============================================
// HELPERS
// ============================================

function chooseProvider(preferred: string | undefined, mode: "generate" | "edit"): "gemini" | "openai" {
  if (preferred === "openai") return "openai";
  if (preferred === "gemini") return "gemini";

  // Default: Gemini for both generation and editing
  if (GEMINI_API_KEY) return "gemini";
  if (OPENAI_API_KEY) return "openai";

  return "gemini"; // Will fail with helpful error message
}

function mapAspectToOpenAISize(aspectRatio: string): string {
  switch (aspectRatio) {
    case "16:9":
    case "4:3": return "1536x1024";  // landscape
    case "9:16":
    case "3:4": return "1024x1536";  // portrait
    case "1:1": return "1024x1024";
    default: return "auto";          // let gpt-image-1.5 decide
  }
}

/**
 * Read an image file from the user's machine via the execution bridge.
 * Returns base64 data and mime type.
 */
async function readImageFromAgent(
  path: string,
  executeCommand: ExecuteCommandFn
): Promise<{ mimeType: string; data: string } | null> {
  try {
    // Use PowerShell to read and base64-encode the file
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

    // Detect mime type from extension
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
 * Returns the resolved path or null on failure.
 */
async function saveImageToAgent(
  base64Data: string,
  mimeType: string,
  savePath: string,
  executeCommand: ExecuteCommandFn,
  tempDir?: string
): Promise<string | null> {
  try {
    // Determine file extension from mime type
    const extMap: Record<string, string> = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
    };
    const ext = extMap[mimeType] || ".png";

    // Ensure save path has correct extension
    let finalPath = savePath;
    if (!finalPath.match(/\.\w+$/)) {
      finalPath += ext;
    }

    // Strategy: write base64 as a text file via file_write (uses Node's fs.writeFile,
    // no command-line length limit), then decode with a small PowerShell command.
    // This avoids Windows' ~32K CreateProcess command-line limit that broke
    // the old approach of embedding base64 inline in PowerShell -Command args.
    const tempFileName = `dotbot_img_${nanoid(8)}.b64`;
    // Use client's temp dir if available, fall back to ~/.bot/temp/
    const tempBase = tempDir || "~/.bot/temp";
    const tempPath = `${tempBase}/${tempFileName}`;

    log.info(`Writing ${base64Data.length} chars base64 to temp file`, { tempPath });

    // Step 1: Write base64 string to temp file via file_write (reliable for any size)
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

    // Step 2: Small PowerShell command to decode base64 temp file → binary image
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
