/**
 * PDF Tool Handler
 *
 * Uses pdf-parse for reading. Merge/split/images require pdf-lib or external tools.
 */

import { resolve } from "path";
import { promises as fs } from "fs";
import type { ToolExecResult } from "../_shared/types.js";

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return resolve(process.env.USERPROFILE || process.env.HOME || "", p.slice(2));
  }
  return resolve(p);
}

export async function handlePdf(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "pdf.read": {
      if (!args.path) return { success: false, output: "", error: "path is required" };
      try {
        const pdfParse = await import("pdf-parse");
        const filePath = resolvePath(args.path);
        const buffer = await fs.readFile(filePath);
        const data = await (pdfParse.default || pdfParse)(buffer);
        const text = data.text || "";
        const truncated = text.length > 8000 ? text.substring(0, 8000) + "\n...[truncated, " + text.length + " chars total]" : text;
        if (args.format === "json") {
          return { success: true, output: JSON.stringify({ pages: data.numpages, text: truncated, info: data.info }, null, 2) };
        }
        return { success: true, output: "Pages: " + data.numpages + "\n\n" + truncated };
      } catch (err: any) {
        if (err.code === "MODULE_NOT_FOUND" || err.message?.includes("Cannot find")) {
          return { success: false, output: "", error: "PDF reading requires the 'pdf-parse' npm package. Run: npm install pdf-parse --save -w local-agent" };
        }
        return { success: false, output: "", error: "Failed to read PDF: " + err.message };
      }
    }
    case "pdf.merge": {
      if (!args.input_paths || !args.output_path) return { success: false, output: "", error: "input_paths and output_path are required" };
      try {
        const { PDFDocument } = await import("pdf-lib");
        const merged = await PDFDocument.create();
        const paths = Array.isArray(args.input_paths) ? args.input_paths : JSON.parse(args.input_paths);
        for (const p of paths) {
          const bytes = await fs.readFile(resolvePath(p));
          const doc = await PDFDocument.load(bytes);
          const pages = await merged.copyPages(doc, doc.getPageIndices());
          for (const page of pages) merged.addPage(page);
        }
        const outBytes = await merged.save();
        const outPath = resolvePath(args.output_path);
        await fs.writeFile(outPath, outBytes);
        return { success: true, output: "Merged " + paths.length + " PDFs (" + merged.getPageCount() + " pages) to " + outPath };
      } catch (err: any) {
        if (err.code === "MODULE_NOT_FOUND" || err.message?.includes("Cannot find")) {
          return { success: false, output: "", error: "PDF merge requires the 'pdf-lib' npm package. Run: npm install pdf-lib --save -w local-agent" };
        }
        return { success: false, output: "", error: "Failed to merge PDFs: " + err.message };
      }
    }
    case "pdf.split": {
      if (!args.input_path || !args.output_dir) return { success: false, output: "", error: "input_path and output_dir are required" };
      try {
        const { PDFDocument } = await import("pdf-lib");
        const bytes = await fs.readFile(resolvePath(args.input_path));
        const src = await PDFDocument.load(bytes);
        const outDir = resolvePath(args.output_dir);
        await fs.mkdir(outDir, { recursive: true });

        const totalPages = src.getPageCount();
        const created: string[] = [];

        for (let i = 0; i < totalPages; i++) {
          const doc = await PDFDocument.create();
          const [page] = await doc.copyPages(src, [i]);
          doc.addPage(page);
          const outPath = resolve(outDir, "page-" + (i + 1) + ".pdf");
          await fs.writeFile(outPath, await doc.save());
          created.push(outPath);
        }
        return { success: true, output: "Split into " + created.length + " files in " + outDir };
      } catch (err: any) {
        if (err.code === "MODULE_NOT_FOUND" || err.message?.includes("Cannot find")) {
          return { success: false, output: "", error: "PDF split requires the 'pdf-lib' npm package. Run: npm install pdf-lib --save -w local-agent" };
        }
        return { success: false, output: "", error: "Failed to split PDF: " + err.message };
      }
    }
    case "pdf.to_images": {
      return { success: false, output: "", error: "PDF to images requires an external tool like poppler (pdftoppm) or ghostscript. Install poppler and use shell.powershell to run: pdftoppm -png input.pdf output_prefix" };
    }
    default:
      return { success: false, output: "", error: "Unknown pdf tool: " + toolId };
  }
}
