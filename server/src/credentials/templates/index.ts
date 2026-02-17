/**
 * Credential Page Templates
 *
 * Loads HTML template files from disk and renders them with placeholder interpolation.
 * Templates use {{placeholder}} syntax for dynamic values.
 */

import fs from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================
// TEMPLATE CACHE
// ============================================

const cache = new Map<string, string>();

function loadTemplate(name: string): string {
  const cached = cache.get(name);
  if (cached) return cached;

  const filePath = join(__dirname, `${name}.html`);
  const content = fs.readFileSync(filePath, "utf-8");
  cache.set(name, content);
  return content;
}

// ============================================
// INTERPOLATION
// ============================================

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;")
   .replace(/</g, "&lt;")
   .replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;");

/**
 * Convert bare URLs in already-escaped HTML into clickable <a> tags.
 * Matches http/https URLs and stops at whitespace or trailing punctuation.
 */
function autoLinkUrls(escaped: string): string {
  // Match URLs in already-escaped HTML. Stop at whitespace or HTML entity starts (&amp; etc.)
  return escaped.replace(
    /https?:\/\/[^\s<>"]+/g,
    (url) => {
      // Strip trailing punctuation that likely isn't part of the URL
      const clean = url.replace(/[.,;:!?)\]]+$/, "");
      const trailing = url.slice(clean.length);
      return `<a href="${clean}" target="_blank" rel="noopener noreferrer" class="text-purple underline hover:text-accent break-all">${clean}</a>${trailing}`;
    },
  );
}

/**
 * Format a prompt string for display:
 * 1. Escape HTML
 * 2. Convert numbered lines (e.g. "1. ...", "2) ...") into an <ol>
 * 3. Auto-link URLs
 */
function formatPrompt(raw: string): string {
  const escaped = escapeHtml(raw);
  const lines = escaped.split(/\n/);

  // Detect numbered steps: lines starting with "1." "2." or "1)" "2)" etc.
  const numberedLineRe = /^\s*\d+[.):]\s+/;
  const hasNumberedSteps = lines.filter(l => numberedLineRe.test(l)).length >= 2;

  if (hasNumberedSteps) {
    // Group into intro text, ordered list items, and trailing text
    const parts: string[] = [];
    let inList = false;

    for (const line of lines) {
      if (numberedLineRe.test(line)) {
        if (!inList) {
          parts.push('<ol class="list-decimal list-inside space-y-2 my-3">');
          inList = true;
        }
        const content = line.replace(numberedLineRe, "").trim();
        parts.push(`  <li>${autoLinkUrls(content)}</li>`);
      } else {
        if (inList) {
          parts.push("</ol>");
          inList = false;
        }
        const trimmed = line.trim();
        if (trimmed) {
          parts.push(`<p>${autoLinkUrls(trimmed)}</p>`);
        }
      }
    }
    if (inList) parts.push("</ol>");
    return parts.join("\n");
  }

  // No numbered steps — just auto-link and preserve line breaks
  return autoLinkUrls(escaped);
}

function render(templateName: string, vars: Record<string, string>): string {
  const raw = loadTemplate(templateName);
  return raw.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value !== undefined ? value : "";
  });
}

// ============================================
// QR BLOCK PARTIAL
// ============================================

function qrBlockHtml(qrSvg: string): string {
  if (!qrSvg) return "";
  return `
    <div class="mt-5 p-4 bg-[#162032] border border-[#1e3a5f] rounded-lg flex items-center gap-4">
      <div class="shrink-0 w-[120px] h-[120px] [&>svg]:w-full [&>svg]:h-full">${qrSvg}</div>
      <div class="text-xs text-[#7dd3fc] leading-relaxed">
        <strong class="text-[#a78bfa] text-[13px]">&#x1f4f1; Prefer a different device?</strong><br>
        Scan this QR code to open this page on your phone or tablet.
        This protects against keyloggers, browser extensions, or other
        software that may be monitoring this computer.
      </div>
    </div>`;
}

// ============================================
// PUBLIC API
// ============================================

export function renderEntryPage(vars: {
  title: string;
  prompt: string;
  keyName: string;
  token: string;
  allowedDomain: string;
  qrSvg: string;
}): string {
  return render("entry", {
    title: escapeHtml(vars.title),
    prompt: formatPrompt(vars.prompt),
    keyName: escapeHtml(vars.keyName),
    token: escapeHtml(vars.token),
    allowedDomain: escapeHtml(vars.allowedDomain),
    qrBlock: qrBlockHtml(vars.qrSvg),
  });
}

export function renderSuccessPage(keyName: string): string {
  return render("success", { keyName: escapeHtml(keyName) });
}

export function renderExpiredPage(): string {
  return render("expired", {});
}

export function renderErrorPage(message: string): string {
  return render("error", { message: escapeHtml(message) });
}

export function renderSessionUnauthedPage(): string {
  return render("session-unauthed", {});
}

export function renderSessionAuthedPage(deviceId: string, userId: string): string {
  return render("session-authed", {
    deviceId: escapeHtml(deviceId),
    userId: escapeHtml(userId),
  });
}
