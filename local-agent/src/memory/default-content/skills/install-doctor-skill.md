---
name: install-doctor
description: Reads install-status.json from the installer and automatically fixes any failed optional components (Python packages, Playwright, Tesseract OCR). Runs after first launch if the installer reported issues.
tags: [install, doctor, fix, repair, python, playwright, tesseract, setup]
disable-model-invocation: false
user-invocable: true
allowed-tools: [shell.powershell, system.health_check, filesystem.read_file]
---

# Install Doctor — Fix Failed Optional Components

## EXECUTION MODEL
This skill runs **autonomously**. Execute all tool calls yourself — do NOT stop between steps or ask for permission.

## Overview
The DotBot installer classifies steps into tiers:
- **Tier 1** (Critical): Git, Node.js — installer won't continue without these
- **Tier 2** (Optional): Python, pip packages, Tesseract OCR, Playwright — installer continues if these fail
- **Tier 3** (Enhancement): Task Scheduler, Start Menu shortcut — nice-to-have

This skill reads `install-status.json` and attempts to fix any failed Tier 2 components.

## Step 1: Read Install Status

```
filesystem.read_file({ path: "~/.bot/install-status.json" })
```

If the file doesn't exist, tell the user their install looks clean and stop.

Parse the JSON. Look for any steps with `"result": "failed"` or `"result": "skipped"`.

If all steps passed, tell the user everything looks good and stop.

## Step 2: Fix Failed Components

For each failed component, attempt the fix:

### Python / pip packages
```
shell.powershell({ command: "python -m pip install --user pyautogui pywinauto Pillow 2>&1" })
```
If Python itself isn't installed:
```
shell.powershell({ command: "winget install Python.Python.3.11 --accept-package-agreements --accept-source-agreements 2>&1" })
```
Then retry pip packages.

### Tesseract OCR
```
shell.powershell({ command: "winget install UB-Mannheim.TesseractOCR --accept-package-agreements --accept-source-agreements 2>&1" })
```
Verify:
```
shell.powershell({ command: "tesseract --version 2>&1 | Select-Object -First 1" })
```

### Playwright Chromium
```
shell.powershell({ command: "npx playwright install chromium 2>&1" })
```

## Step 3: Verify Fixes

Run a health check:
```
system.health_check({})
```

## Step 4: Report Results

Present a summary:
```
Install Doctor Results:
  [fixed/still broken] Python packages (pyautogui, pywinauto, Pillow)
  [fixed/still broken] Tesseract OCR
  [fixed/still broken] Playwright Chromium
```

If anything is still broken, explain what the user can do manually and offer to try again.

## When to Run
- Automatically on first launch if `install-status.json` has failures
- When user asks to "fix my install" or "run install doctor"
- After a system.health_check shows missing components
