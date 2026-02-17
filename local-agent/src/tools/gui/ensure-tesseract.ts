/**
 * Tesseract OCR Auto-Installer
 * 
 * Checks if Tesseract OCR is installed and automatically downloads + installs
 * it if missing. Used by the SmartNavigator Tier 2 (Regional OCR) and
 * Tier 3 (Full Window OCR + LLM).
 * 
 * Install location: ~/.bot/tesseract/
 * Source: UB-Mannheim Tesseract builds (GitHub)
 * 
 * Non-fatal: if install fails, Tier 1 (accessibility tree) still works.
 * Tiers 2/3 degrade gracefully to "element not found".
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { homedir } from "os";
import { promises as fs, createWriteStream } from "fs";
import https from "https";
import http from "http";

const execFileP = promisify(execFile);

/** Directory where Tesseract is installed */
const TESSERACT_DIR = join(homedir(), ".bot", "tesseract");

/** Expected path to tesseract.exe after installation */
const TESSERACT_EXE = join(TESSERACT_DIR, "tesseract.exe");

/** Fallback download URL — known stable UB-Mannheim build */
const FALLBACK_INSTALLER_URL =
  "https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe";

/** GitHub API for latest UB-Mannheim release */
const GITHUB_RELEASES_API =
  "https://api.github.com/repos/UB-Mannheim/tesseract/releases/latest";

// ============================================
// DETECTION
// ============================================

/**
 * Check if Tesseract is available.
 * Returns the path to tesseract.exe if found, null otherwise.
 */
export async function findTesseract(): Promise<string | null> {
  // 1. Check our managed install location
  try {
    await fs.access(TESSERACT_EXE);
    return TESSERACT_EXE;
  } catch { /* not there */ }

  // 2. Check if tesseract is on PATH
  try {
    const { stdout } = await execFileP("where", ["tesseract"], { timeout: 5_000 });
    const firstLine = stdout.trim().split("\n")[0]?.trim();
    if (firstLine) {
      await fs.access(firstLine);
      return firstLine;
    }
  } catch { /* not on PATH */ }

  // 3. Check common Windows install paths
  const commonPaths = [
    "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
    "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe",
    join(homedir(), "AppData", "Local", "Tesseract-OCR", "tesseract.exe"),
  ];
  for (const p of commonPaths) {
    try {
      await fs.access(p);
      return p;
    } catch { /* not there */ }
  }

  return null;
}

/**
 * Verify Tesseract works by running --version.
 */
async function verifyTesseract(exePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP(exePath, ["--version"], { timeout: 10_000 });
    return stdout.includes("tesseract");
  } catch {
    return false;
  }
}

// ============================================
// DOWNLOAD
// ============================================

/**
 * Download a file from a URL, following redirects.
 */
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const makeRequest = (reqUrl: string, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error("Too many redirects"));
        return;
      }

      const proto = reqUrl.startsWith("https") ? https : http;
      proto.get(reqUrl, { headers: { "User-Agent": "DotBot/1.0" } }, (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          makeRequest(res.headers.location, redirects + 1);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${reqUrl}`));
          return;
        }

        const fileStream = createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close();
          resolve();
        });
        fileStream.on("error", reject);
      }).on("error", reject);
    };

    makeRequest(url);
  });
}

/**
 * Try to get the latest w64 installer URL from GitHub releases API.
 * Falls back to hardcoded URL on failure.
 */
async function getInstallerUrl(): Promise<string> {
  try {
    const data = await new Promise<string>((resolve, reject) => {
      https.get(GITHUB_RELEASES_API, {
        headers: { "User-Agent": "DotBot/1.0", Accept: "application/vnd.github.v3+json" },
        timeout: 10_000,
      }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API returned ${res.statusCode}`));
          return;
        }
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => resolve(body));
      }).on("error", reject);
    });

    const release = JSON.parse(data);
    const assets = release.assets || [];
    // Find the w64 setup exe
    const w64Asset = assets.find((a: any) =>
      a.name.includes("w64") && a.name.endsWith(".exe") && a.name.includes("setup")
    );
    if (w64Asset?.browser_download_url) {
      console.log(`[Tesseract] Latest release: ${release.tag_name}`);
      return w64Asset.browser_download_url;
    }
  } catch (err) {
    console.log("[Tesseract] Could not fetch latest release, using fallback URL");
  }

  return FALLBACK_INSTALLER_URL;
}

// ============================================
// INSTALLATION
// ============================================

/**
 * Download and install Tesseract OCR.
 * 
 * Fallback chain:
 * 1. NSIS silent install (/S /D=) → direct spawn, then PowerShell Start-Process if EACCES
 * 2. winget install (handles its own elevation)
 * 3. Interactive NSIS install → UAC prompt, user clicks through installer GUI
 * 4. All fail → return false (caller provides manual instructions to user)
 */
async function installTesseract(): Promise<boolean> {
  // Method 1: Download NSIS installer (silent, no admin)
  if (await installViaNSIS()) return true;

  // Method 2: Try winget (handles its own elevation)
  if (await installViaWinget()) return true;

  // Method 3: Launch installer interactively — user clicks through UAC
  if (await installInteractive()) return true;

  return false;
}

/**
 * Method 1: Download NSIS installer and run silently.
 * Tries direct spawn first, then PowerShell Start-Process if EACCES.
 */
async function installViaNSIS(): Promise<boolean> {
  const tempDir = join(homedir(), ".bot", "temp");
  await fs.mkdir(tempDir, { recursive: true });

  const installerPath = join(tempDir, "tesseract-installer.exe");

  try {
    const url = await getInstallerUrl();
    console.log(`[Tesseract] Downloading from: ${url.split("/").pop()}`);
    console.log("[Tesseract] This may take 1-2 minutes (~70MB)...");

    await downloadFile(url, installerPath);
    console.log("[Tesseract] Download complete, installing...");

    await fs.mkdir(TESSERACT_DIR, { recursive: true });

    // Remove Zone.Identifier ADS (Mark of the Web) — the #1 cause of EACCES
    try {
      await execFileP("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Unblock-File -Path '${installerPath.replace(/'/g, "''")}'`,
      ], { timeout: 10_000, windowsHide: true });
    } catch (err) {
      console.warn("[Tesseract] Unblock-File failed:", err instanceof Error ? err.message : err);
    }

    // Also try removing the ADS directly via cmd (belt + suspenders)
    try {
      await execFileP("cmd.exe", ["/c", `echo.> "${installerPath}:Zone.Identifier"`], {
        timeout: 5_000, windowsHide: true,
      });
    } catch { /* ok — Unblock-File may have already handled it */ }

    // Attempt 1: Direct spawn
    const nsisArgs = ["/S", `/D=${TESSERACT_DIR}`];
    try {
      await execFileP(installerPath, nsisArgs, {
        timeout: 120_000,
        windowsHide: true,
      });
      console.log("[Tesseract] NSIS installation complete");
      return true;
    } catch (err: any) {
      const code = err?.code || "";
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Tesseract] Direct spawn failed (${code}): ${msg}`);

      // Attempt 2: PowerShell Start-Process (can bypass some ADS/execution policy issues)
      if (code === "EACCES" || msg.includes("EACCES")) {
        console.log("[Tesseract] Retrying via PowerShell Start-Process...");
        try {
          await execFileP("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Start-Process -FilePath '${installerPath.replace(/'/g, "''")}' -ArgumentList '/S','/D=${TESSERACT_DIR.replace(/'/g, "''")}' -Wait -NoNewWindow`,
          ], { timeout: 120_000, windowsHide: true });
          console.log("[Tesseract] PowerShell Start-Process installation complete");
          return true;
        } catch (psErr) {
          console.warn("[Tesseract] PowerShell Start-Process also failed:", psErr instanceof Error ? psErr.message : psErr);
        }
      }
    }

    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Tesseract] NSIS install failed: ${msg}`);
    return false;
  }
  // Don't delete installer here — installInteractive() may reuse it
}

/**
 * Method 2: Install via winget (Windows Package Manager).
 * Available on Windows 10 1809+ and Windows 11.
 * Installs to Program Files but doesn't need admin for per-user scope.
 */
async function installViaWinget(): Promise<boolean> {
  try {
    console.log("[Tesseract] Trying winget install...");
    await execFileP("winget", [
      "install", "UB-Mannheim.TesseractOCR",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--silent",
    ], { timeout: 180_000, windowsHide: true });
    console.log("[Tesseract] winget installation complete");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Tesseract] winget install failed: ${msg}`);
    return false;
  }
}

/**
 * Method 3: Launch the NSIS installer interactively with UAC elevation.
 * The user sees the installer GUI and clicks through the UAC prompt.
 * We wait for the process to finish, then check if Tesseract appeared.
 */
async function installInteractive(): Promise<boolean> {
  const tempDir = join(homedir(), ".bot", "temp");
  const installerPath = join(tempDir, "tesseract-installer.exe");

  // Check if the installer is still on disk from the silent attempt
  let hasInstaller = false;
  try {
    await fs.access(installerPath);
    hasInstaller = true;
  } catch { /* not there — need to re-download */ }

  if (!hasInstaller) {
    try {
      await fs.mkdir(tempDir, { recursive: true });
      const url = await getInstallerUrl();
      console.log(`[Tesseract] Re-downloading installer for interactive install...`);
      await downloadFile(url, installerPath);
    } catch (err) {
      console.warn("[Tesseract] Download for interactive install failed:", err instanceof Error ? err.message : err);
      return false;
    }
  }

  try {
    // Unblock before launching
    try {
      await execFileP("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Unblock-File -Path '${installerPath.replace(/'/g, "''")}'`,
      ], { timeout: 10_000, windowsHide: true });
    } catch { /* best effort */ }

    console.log("[Tesseract] Launching installer with UAC elevation — user will see the installer window...");

    // Start-Process -Verb RunAs triggers UAC prompt, -Wait blocks until installer closes
    await execFileP("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Start-Process -FilePath '${installerPath.replace(/'/g, "''")}' -Verb RunAs -Wait`,
    ], { timeout: 300_000, windowsHide: true }); // 5 min — user is clicking through GUI

    console.log("[Tesseract] Interactive installer finished");

    // Check if it worked (user may have installed to default Program Files location)
    const found = await findTesseract();
    if (found) {
      console.log(`[Tesseract] Found after interactive install: ${found}`);
      return true;
    }

    console.warn("[Tesseract] Interactive installer finished but tesseract.exe not found");
    return false;
  } catch (err) {
    // User may have declined UAC — that's ok
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Tesseract] Interactive install failed (user may have declined UAC): ${msg}`);
    return false;
  } finally {
    try { await fs.unlink(installerPath); } catch { /* ok */ }
  }
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Ensure Tesseract OCR is installed. If not, download and install automatically.
 * 
 * Returns:
 * - { available: true, path: string } — ready to use
 * - { available: false, error: string } — not available (non-fatal)
 */
export async function ensureTesseract(): Promise<{
  available: boolean;
  path?: string;
  error?: string;
}> {
  // Check if already installed
  const existing = await findTesseract();
  if (existing) {
    const works = await verifyTesseract(existing);
    if (works) {
      console.log(`[Tesseract] OCR engine ready: ${existing}`);
      return { available: true, path: existing };
    }
  }

  console.log("[Tesseract] OCR engine not found — installing automatically...");

  // Attempt auto-install
  const installed = await installTesseract();
  if (!installed) {
    return {
      available: false,
      error: [
        "Tesseract OCR auto-install failed (tried NSIS installer + winget).",
        "Tier 2/3 OCR will be unavailable until installed manually.",
        "",
        "Manual install options:",
        "1. winget: winget install UB-Mannheim.TesseractOCR",
        "2. Verified release page: https://github.com/UB-Mannheim/tesseract/releases",
        "   → Open the latest release and download the w64-setup .exe installer",
        "   → Install to default location (C:\\Program Files\\Tesseract-OCR)",
        "3. Chocolatey (admin): choco install tesseract -y",
        "",
        "IMPORTANT: Do not guess direct .exe/.zip asset URLs from memory.",
        "Always use the official releases page above and pick the latest w64 setup installer.",
        "",
        "After installing, restart the agent. Tesseract will be detected automatically.",
      ].join("\n"),
    };
  }

  // Verify installation
  const newPath = await findTesseract();
  if (newPath) {
    const works = await verifyTesseract(newPath);
    if (works) {
      console.log(`[Tesseract] OCR engine installed and verified: ${newPath}`);
      return { available: true, path: newPath };
    }
  }

  return {
    available: false,
    error: "Tesseract installed but verification failed. Check ~/.bot/tesseract/",
  };
}

/**
 * Get the Tesseract executable path (if available).
 * Does NOT trigger install — call ensureTesseract() first.
 */
export async function getTesseractPath(): Promise<string | null> {
  return await findTesseract();
}

/** Export constants for tests */
export const TESSERACT_INSTALL_DIR = TESSERACT_DIR;
