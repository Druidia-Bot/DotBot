/**
 * Gemini Video Client
 *
 * Uses generateContent with responseModalities: ["VIDEO", "TEXT"]
 * for video generation via the Gemini API (Veo models).
 */

import { createComponentLogger } from "#logging.js";
import type {
  IVideoClient,
  LLMProvider,
  VideoGenerateRequest,
  VideoResult,
} from "../../types.js";
import { PROVIDER_CONFIGS } from "../../config.js";

const log = createComponentLogger("llm.gemini.video");

const VIDEO_MODEL_DEFAULT = "veo-3.1-fast-generate-preview";

export class GeminiVideoClient implements IVideoClient {
  provider: LLMProvider = "gemini";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || PROVIDER_CONFIGS.gemini.baseUrl!;
  }

  async generate(request: VideoGenerateRequest): Promise<VideoResult> {
    const model = request.model || VIDEO_MODEL_DEFAULT;
    const parts: any[] = [{ text: request.prompt }];

    if (request.referenceImage) {
      parts.push({
        inline_data: { mime_type: request.referenceImage.mimeType, data: request.referenceImage.data },
      });
    }

    const url = `${this.baseUrl}/v1beta/models/${model}:generateContent?key=${this.apiKey}`;

    const body: any = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["VIDEO", "TEXT"],
      },
    };

    if (request.aspectRatio) {
      body.generationConfig.videoConfig = { aspectRatio: request.aspectRatio };
    }
    if (request.durationSeconds) {
      body.generationConfig.videoConfig = {
        ...body.generationConfig.videoConfig,
        durationSeconds: request.durationSeconds,
      };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000), // 5 min — video gen is slow
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini video API error: ${response.status} ${errorText.substring(0, 500)}`);
    }

    const data = await response.json() as any;
    const candidates = Array.isArray(data) ? data : [data];

    let base64 = "";
    let mimeType = "video/mp4";
    let description = "";

    for (const chunk of candidates) {
      const candidate = chunk.candidates?.[0];
      if (!candidate?.content?.parts) continue;
      for (const part of candidate.content.parts) {
        if (part.text) description += part.text;
        else if (part.inlineData) {
          base64 = part.inlineData.data;
          mimeType = part.inlineData.mimeType || "video/mp4";
        }
      }
    }

    if (!base64) {
      throw new Error("Gemini video response contained no video data");
    }

    log.info(`Gemini video generated: ${base64.length} chars base64, ${mimeType}`);
    return { base64, mimeType, description: description.trim() || undefined };
  }
}
