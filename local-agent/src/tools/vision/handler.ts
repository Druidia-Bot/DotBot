/**
 * Vision/OCR Tool Handler
 *
 * OCR uses Tesseract via PowerShell. Image analysis defers to the server LLM.
 */

import { resolve } from "path";
import type { ToolExecResult } from "../_shared/types.js";
import { sanitizeForPS, runPowershell } from "../_shared/powershell.js";

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return resolve(process.env.USERPROFILE || process.env.HOME || "", p.slice(2));
  }
  return resolve(p);
}

export async function handleVision(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "vision.ocr": {
      if (!args.image_path) return { success: false, output: "", error: "image_path is required" };
      const imgPath = sanitizeForPS(resolvePath(args.image_path));
      const lang = args.language || "eng";
      const langSafe = /^[a-z]{3}(\+[a-z]{3})*$/i.test(lang) ? lang : "eng";
      const script = [
        '$tesseract = "C:\\Program Files\\Tesseract-OCR\\tesseract.exe"',
        'if (!(Test-Path $tesseract)) { $tesseract = (Get-Command tesseract -ErrorAction SilentlyContinue).Source }',
        'if (!$tesseract) { "ERROR: Tesseract not found. Install via: winget install UB-Mannheim.TesseractOCR"; return }',
        '$tmp = [System.IO.Path]::GetTempFileName()',
        '& $tesseract "' + imgPath + '" $tmp -l ' + langSafe + ' 2>$null',
        'Get-Content "$tmp.txt" -Raw',
        'Remove-Item "$tmp*" -Force -ErrorAction SilentlyContinue',
      ].join("; ");
      return runPowershell(script, 60_000);
    }
    case "vision.analyze_image": {
      return { success: false, output: "", error: "Image analysis requires server-side LLM with vision capability. Use the server's Gemini deep_context model via the research pipeline instead." };
    }
    case "vision.find_in_image": {
      if (!args.image_path || !args.target) return { success: false, output: "", error: "image_path and target are required" };
      if (args.mode === "text" || !args.mode) {
        const imgPath = sanitizeForPS(resolvePath(args.image_path));
        const target = sanitizeForPS(args.target);
        const script = [
          '$tesseract = "C:\\Program Files\\Tesseract-OCR\\tesseract.exe"',
          'if (!(Test-Path $tesseract)) { $tesseract = (Get-Command tesseract -ErrorAction SilentlyContinue).Source }',
          'if (!$tesseract) { "ERROR: Tesseract not found"; return }',
          '$tmp = [System.IO.Path]::GetTempFileName()',
          '& $tesseract "' + imgPath + '" $tmp tsv 2>$null',
          '$lines = Get-Content "$tmp.tsv" | ConvertFrom-Csv -Delimiter "`t"',
          '$matches = $lines | Where-Object { $_.text -like "*' + target + '*" } | Select-Object left, top, width, height, text',
          'Remove-Item "$tmp*" -Force -ErrorAction SilentlyContinue',
          'if ($matches) { $matches | ConvertTo-Json } else { "No text matching \'' + target + '\' found in image" }',
        ].join("; ");
        return runPowershell(script, 60_000);
      }
      return { success: false, output: "", error: "Template matching mode requires OpenCV (Python). Use gui.read_state with visual mode instead." };
    }
    default:
      return { success: false, output: "", error: "Unknown vision tool: " + toolId };
  }
}
