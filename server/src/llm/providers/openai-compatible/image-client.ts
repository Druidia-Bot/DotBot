/**
 * OpenAI Image Client
 *
 * Uses the OpenAI images/generations endpoint with gpt-image-1.5.
 * Returns base64 PNG data.
 */

import { createComponentLogger } from "#logging.js";
import type {
  IImageClient,
  LLMProvider,
  ImageGenerateRequest,
  ImageEditRequest,
  ImageResult,
} from "../../types.js";

const log = createComponentLogger("llm.openai.image");

/**
 * Map aspect ratio to OpenAI size parameter.
 * Sizes: 1024x1024, 1536x1024 (landscape), 1024x1536 (portrait), or auto.
 */
function mapAspectToSize(aspectRatio?: string): string {
  switch (aspectRatio) {
    case "16:9":
    case "4:3": return "1536x1024";
    case "9:16":
    case "3:4": return "1024x1536";
    case "1:1": return "1024x1024";
    default: return "auto";
  }
}

export class OpenAIImageClient implements IImageClient {
  provider: LLMProvider = "openai";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || "https://api.openai.com/v1";
  }

  async generate(request: ImageGenerateRequest): Promise<ImageResult> {
    const model = request.model || "gpt-image-1.5";
    const size = request.size || mapAspectToSize(request.aspectRatio);

    const response = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt: request.prompt,
        n: 1,
        size,
        quality: "auto",
        output_format: "png",
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI image API error: ${response.status} ${errorText.substring(0, 500)}`);
    }

    const data = await response.json() as any;
    const imageData = data.data?.[0];
    if (!imageData?.b64_json) {
      throw new Error("OpenAI image response missing image data");
    }

    log.info("OpenAI image generated", {
      model,
      base64Chars: imageData.b64_json.length,
      usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : undefined,
    });

    return {
      base64: imageData.b64_json,
      mimeType: "image/png",
      description: imageData.revised_prompt ? `Revised prompt: ${imageData.revised_prompt}` : undefined,
    };
  }

  async edit(request: ImageEditRequest): Promise<ImageResult> {
    // OpenAI doesn't have a true image edit endpoint for GPT image models.
    // Approximate by generating with an edit-style prompt.
    const editPrompt = `Based on an existing image, create a new version with these changes: ${request.prompt}. Maintain the same overall style and composition.`;
    return this.generate({
      ...request,
      prompt: editPrompt,
    });
  }
}
