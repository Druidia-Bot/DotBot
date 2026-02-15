/**
 * Gemini Image Client
 *
 * Uses streamGenerateContent with responseModalities: ["IMAGE", "TEXT"]
 * for native image generation via the Gemini API.
 */

import { createComponentLogger } from "#logging.js";
import type {
  IImageClient,
  LLMProvider,
  ImageGenerateRequest,
  ImageEditRequest,
  ImageResult,
} from "../../types.js";
import { PROVIDER_CONFIGS } from "../../config.js";

const log = createComponentLogger("llm.gemini.image");

const IMAGE_MODEL_DEFAULT = "gemini-3-pro-image-preview";

export class GeminiImageClient implements IImageClient {
  provider: LLMProvider = "gemini";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || PROVIDER_CONFIGS.gemini.baseUrl!;
  }

  async generate(request: ImageGenerateRequest): Promise<ImageResult> {
    const model = request.model || IMAGE_MODEL_DEFAULT;
    const parts: any[] = [{ text: request.prompt }];

    if (request.referenceImages?.length) {
      for (const img of request.referenceImages) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
      }
    }

    return this.callImageAPI(model, parts, request.aspectRatio || "1:1");
  }

  async edit(request: ImageEditRequest): Promise<ImageResult> {
    const model = request.model || IMAGE_MODEL_DEFAULT;
    const parts: any[] = [
      { text: request.prompt },
      { inline_data: { mime_type: request.sourceImage.mimeType, data: request.sourceImage.data } },
    ];

    if (request.referenceImages?.length) {
      for (const img of request.referenceImages) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
      }
    }

    return this.callImageAPI(model, parts, request.aspectRatio || "1:1");
  }

  private async callImageAPI(model: string, parts: any[], aspectRatio: string): Promise<ImageResult> {
    const url = `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?key=${this.apiKey}`;

    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"],
        imageConfig: {
          aspectRatio,
          imageSize: "1K",
          personGeneration: "",
        },
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini image API error: ${response.status} ${errorText.substring(0, 500)}`);
    }

    const data = await response.json() as any[];
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("Gemini image response empty or invalid");
    }

    let base64 = "";
    let mimeType = "image/png";
    let description = "";

    for (const chunk of data) {
      const candidate = chunk.candidates?.[0];
      if (!candidate?.content?.parts) continue;
      for (const part of candidate.content.parts) {
        if (part.text) description += part.text;
        else if (part.inlineData) {
          base64 = part.inlineData.data;
          mimeType = part.inlineData.mimeType || "image/png";
        }
      }
    }

    if (!base64) {
      throw new Error("Gemini image response contained no image data");
    }

    log.info(`Gemini image generated: ${base64.length} chars base64, ${mimeType}`);
    return { base64, mimeType, description: description.trim() || undefined };
  }
}
