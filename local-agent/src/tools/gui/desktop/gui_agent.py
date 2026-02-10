"""
DotBot Desktop GUI Agent — Python subprocess for native app automation.

Called by the Node.js local agent via python-bridge.ts.
Receives JSON commands on stdin, returns JSON results on stdout.
Supports both one-shot (--tool/--args) and persistent daemon (--daemon) modes.

Implements SmartNavigator cascading fallback:
  Tier 1: Accessibility Tree (pywinauto UIA) — ~50ms
  Tier 2: Regional OCR (pytesseract on small patch) — ~200-500ms
  Tier 3: Full OCR + LLM interpretation — ~2-4s

Usage:
  python gui_agent.py --tool gui.click --args '{"element_text":"3","app_name":"Calculator"}'
  python gui_agent.py --daemon
"""

import sys
import os
import json
import time
import argparse
import traceback
from typing import Optional, Dict, Any, List, Tuple
from difflib import SequenceMatcher

import pyautogui
import pywinauto
from pywinauto import Desktop, Application
from pywinauto.findwindows import ElementNotFoundError, ElementAmbiguousError

# Safety: move mouse to (0,0) to abort
pyautogui.FAILSAFE = True
# Don't pause between actions (we manage our own waits)
pyautogui.PAUSE = 0.05

# ============================================
# TESSERACT OCR DETECTION
# ============================================

TESSERACT_AVAILABLE = False
TESSERACT_PATH: Optional[str] = None

def _detect_tesseract() -> bool:
    """Find Tesseract binary and configure pytesseract."""
    global TESSERACT_AVAILABLE, TESSERACT_PATH
    
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".bot", "tesseract", "tesseract.exe"),
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        os.path.join(home, "AppData", "Local", "Tesseract-OCR", "tesseract.exe"),
    ]
    
    # Check PATH first
    import shutil
    path_tess = shutil.which("tesseract")
    if path_tess:
        candidates.insert(0, path_tess)
    
    for path in candidates:
        if os.path.isfile(path):
            try:
                import pytesseract
                pytesseract.pytesseract.tesseract_cmd = path
                # Verify it works
                pytesseract.get_tesseract_version()
                TESSERACT_PATH = path
                TESSERACT_AVAILABLE = True
                return True
            except Exception:
                continue
    
    return False

# Try to detect at import time (non-fatal)
try:
    _detect_tesseract()
except Exception:
    pass


# ============================================
# WINDOW MANAGEMENT
# ============================================

def find_window(app_name: str):
    """
    Find a top-level window by smart name matching.
    Returns a pywinauto WindowSpecification (supports child_window()) or None.
    
    Matching strategies (tried in order):
    1. Exact phrase match: "OBS Studio" in "OBS Studio 32.0"
    2. All-words match: every word from app_name appears in the title
       e.g., "OBS Studio" → checks "obs" AND "studio" in title
    3. Primary-word match: first word of app_name appears at start of a title word
       e.g., "OBS" matches "OBS 32.0.1 - Profile: Untitled"
    4. Process name match: connect by process name derived from app_name
    5. Fuzzy match: SequenceMatcher ratio > 0.5 on significant title words
    
    Uses Application().connect() instead of Desktop().windows() because
    Desktop returns UIAWrapper objects that lack child_window() — essential
    for the SmartNavigator element search.
    """
    import re
    app_lower = app_name.lower().strip()
    app_words = [w for w in app_lower.split() if len(w) > 1]  # Skip single chars
    
    if not app_lower:
        return None
    
    # Strategy 0: check session cache (instant in daemon mode)
    cached = _get_cached_window(app_name)
    if cached:
        return cached
    
    def _connect_by_handle(handle):
        """Connect by window handle to get full WindowSpecification."""
        try:
            app = Application(backend="uia").connect(handle=handle)
            dlg = app.top_window()
            if dlg.exists(timeout=0.5):
                return dlg
        except Exception:
            pass
        return None
    
    def _title_matches(title_lower: str) -> int:
        """
        Score how well a window title matches app_name.
        Returns: 0=no match, 1=fuzzy, 2=primary word, 3=all words, 4=exact phrase
        """
        if not title_lower.strip():
            return 0
        
        # Exact phrase match
        if app_lower in title_lower:
            return 4
        
        # All-words match (every word from app_name is in the title)
        if app_words and all(w in title_lower for w in app_words):
            return 3
        
        # Primary word match: first significant word of app_name starts a title word
        title_words = title_lower.split()
        if app_words:
            primary = app_words[0]
            for tw in title_words:
                if tw == primary or tw.startswith(primary):
                    return 2
        
        # Fuzzy match: ALL app_words must match at least one title word
        # (prevents 'OBS Studio' matching 'Visual Studio Code' on shared 'studio')
        if app_words and len(app_words) >= 2:
            matched_words = 0
            for aw in app_words:
                for tw in title_words:
                    if SequenceMatcher(None, aw, tw).ratio() > 0.7:
                        matched_words += 1
                        break
            if matched_words == len(app_words):
                return 1
        elif app_words and len(app_words) == 1:
            # Single-word app name: require high ratio against full title
            for tw in title_words:
                if SequenceMatcher(None, app_words[0], tw).ratio() > 0.85:
                    return 1
        
        return 0
    
    # Scan all windows, pick best match
    best_match = None
    best_score = 0
    best_handle = None
    
    try:
        desktop = Desktop(backend="uia")
        for w in desktop.windows():
            try:
                title = w.window_text()
                if not title or not title.strip():
                    continue
                score = _title_matches(title.lower())
                if score > best_score:
                    best_score = score
                    best_match = title
                    best_handle = w.handle
            except Exception:
                continue
    except Exception:
        pass
    
    if best_handle and best_score >= 2:
        result = _connect_by_handle(best_handle)
        if result:
            return result
    
    # Strategy: try connect by title regex (exact phrase)
    try:
        app = Application(backend="uia").connect(
            title_re=f".*(?i){re.escape(app_name)}.*", timeout=2
        )
        dlg = app.top_window()
        if dlg.exists(timeout=0.5):
            return dlg
    except Exception:
        pass
    
    # Strategy: try connect by title regex (primary word only)
    if app_words:
        try:
            primary = re.escape(app_words[0])
            app = Application(backend="uia").connect(
                title_re=f".*(?i){primary}.*", timeout=2
            )
            dlg = app.top_window()
            if dlg.exists(timeout=0.5):
                return dlg
        except Exception:
            pass
    
    # Strategy: scan running processes (like checking Task Manager)
    # This catches cases like "OBS Studio" → process "obs64.exe"
    try:
        import subprocess as _sp
        tasklist = _sp.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=5
        ).stdout
        
        # Build search terms from app_name
        search_terms = [app_lower.replace(" ", "")]  # "obs studio" → "obsstudio"
        if app_words:
            search_terms.append(app_words[0])          # "obs"
        search_terms.append(app_lower.replace(" ", "_"))  # "obs_studio"
        
        # Parse tasklist CSV: "process.exe","PID","Session","Session#","Mem"
        for line in tasklist.strip().split("\n"):
            parts = line.strip().strip('"').split('","')
            if len(parts) < 2:
                continue
            proc_name = parts[0].lower().replace(".exe", "")
            try:
                pid = int(parts[1])
            except (ValueError, IndexError):
                continue
            
            # Check if any search term matches the process name
            for term in search_terms:
                if term in proc_name or proc_name.startswith(term):
                    try:
                        app = Application(backend="uia").connect(process=pid, timeout=2)
                        dlg = app.top_window()
                        if dlg.exists(timeout=0.5):
                            return dlg
                    except Exception:
                        break  # Try next process, not next search term
    except Exception:
        pass
    
    # No reliable match found — return None so navigate can launch the app fresh.
    # (Previously accepted fuzzy score=1 here, but that caused false matches like
    # 'OBS Studio' → 'Visual Studio Code' on shared word 'studio'.)
    return None


def focus_window(window) -> bool:
    """Bring a window to the foreground."""
    try:
        if window.is_minimized():
            window.restore()
        window.set_focus()
        time.sleep(0.1)  # Let window manager settle
        return True
    except Exception:
        return False


def get_window_rect(window) -> Dict[str, int]:
    """Get window bounding rectangle."""
    try:
        rect = window.rectangle()
        return {
            "left": rect.left,
            "top": rect.top,
            "right": rect.right,
            "bottom": rect.bottom,
            "width": rect.width(),
            "height": rect.height(),
        }
    except Exception:
        return {"left": 0, "top": 0, "right": 0, "bottom": 0, "width": 0, "height": 0}


# ============================================
# SMARTNAVIGATOR: TIER 1 — ACCESSIBILITY TREE
# ============================================

def locate_via_accessibility(
    window,
    element_text: str,
    element_type: str = "",
    location_hint: str = "",
) -> Optional[Dict[str, Any]]:
    """
    Tier 1: Use Windows UI Automation to find an element.
    Speed: ~50ms. Reliability: high for native apps.
    
    Returns: {found, method, element_info, rect} or None
    """
    try:
        # Build search criteria
        search_kwargs: Dict[str, Any] = {}
        
        # Map element_type to UIA control types
        type_map = {
            "button": "Button",
            "link": "Hyperlink",
            "input": "Edit",
            "text": "Text",
            "tab": "TabItem",
            "menu_item": "MenuItem",
            "checkbox": "CheckBox",
            "radio": "RadioButton",
            "list_item": "ListItem",
            "tree_item": "TreeItem",
        }
        
        if element_type and element_type in type_map:
            search_kwargs["control_type"] = type_map[element_type]
        
        # Strategy 1: exact name match
        try:
            found = window.child_window(title=element_text, **search_kwargs)
            if found.exists(timeout=0.5):
                rect = found.rectangle()
                return {
                    "found": True,
                    "method": "accessibility_exact",
                    "text": found.window_text(),
                    "control_type": found.element_info.control_type,
                    "rect": {
                        "x": rect.left,
                        "y": rect.top,
                        "w": rect.width(),
                        "h": rect.height(),
                    },
                    "center": {
                        "x": rect.left + rect.width() // 2,
                        "y": rect.top + rect.height() // 2,
                    },
                    "_element": found,
                }
        except (ElementNotFoundError, ElementAmbiguousError):
            pass
        
        # Strategy 2: partial name match (title_re)
        try:
            import re
            escaped = re.escape(element_text)
            found = window.child_window(title_re=f".*{escaped}.*", **search_kwargs)
            if found.exists(timeout=0.5):
                rect = found.rectangle()
                return {
                    "found": True,
                    "method": "accessibility_partial",
                    "text": found.window_text(),
                    "control_type": found.element_info.control_type,
                    "rect": {
                        "x": rect.left,
                        "y": rect.top,
                        "w": rect.width(),
                        "h": rect.height(),
                    },
                    "center": {
                        "x": rect.left + rect.width() // 2,
                        "y": rect.top + rect.height() // 2,
                    },
                    "_element": found,
                }
        except (ElementNotFoundError, ElementAmbiguousError):
            pass
        
        # Strategy 3: AutomationId match
        try:
            found = window.child_window(auto_id=element_text, **search_kwargs)
            if found.exists(timeout=0.3):
                rect = found.rectangle()
                return {
                    "found": True,
                    "method": "accessibility_auto_id",
                    "text": found.window_text(),
                    "control_type": found.element_info.control_type,
                    "rect": {
                        "x": rect.left,
                        "y": rect.top,
                        "w": rect.width(),
                        "h": rect.height(),
                    },
                    "center": {
                        "x": rect.left + rect.width() // 2,
                        "y": rect.top + rect.height() // 2,
                    },
                    "_element": found,
                }
        except (ElementNotFoundError, ElementAmbiguousError):
            pass
        
        return None
    except Exception:
        return None


def list_elements(window, max_depth: int = 3) -> List[Dict[str, Any]]:
    """Walk the UIA tree and return all visible elements."""
    elements = []
    
    def _walk(ctrl, depth: int):
        if depth > max_depth:
            return
        try:
            children = ctrl.children()
            for child in children:
                try:
                    text = child.window_text()
                    ctype = child.element_info.control_type
                    rect = child.rectangle()
                    if rect.width() > 0 and rect.height() > 0:
                        elements.append({
                            "text": text[:80] if text else "",
                            "control_type": ctype,
                            "rect": {
                                "x": rect.left,
                                "y": rect.top,
                                "w": rect.width(),
                                "h": rect.height(),
                            },
                            "auto_id": child.element_info.automation_id or "",
                        })
                    _walk(child, depth + 1)
                except Exception:
                    continue
        except Exception:
            pass
    
    _walk(window, 0)
    return elements


# ============================================
# FUZZY TEXT MATCHING
# ============================================

def fuzzy_score(needle: str, haystack: str) -> float:
    """Return 0.0-1.0 similarity score using SequenceMatcher."""
    if not needle or not haystack:
        return 0.0
    return SequenceMatcher(None, needle.lower(), haystack.lower()).ratio()


def best_fuzzy_match(
    needle: str,
    ocr_items: List[Dict[str, Any]],
    threshold: float = 0.6,
) -> Optional[Dict[str, Any]]:
    """Find the best fuzzy match for needle in a list of OCR items with 'text' field."""
    best = None
    best_score = threshold
    for item in ocr_items:
        text = item.get("text", "").strip()
        if not text:
            continue
        score = fuzzy_score(needle, text)
        if score > best_score:
            best_score = score
            best = {**item, "_score": score}
    return best


# ============================================
# SMARTNAVIGATOR: TIER 2 — REGIONAL OCR
# ============================================

def _get_region_rect(window_rect, hint: str) -> Tuple[int, int, int, int]:
    """Calculate a sub-region of the window based on location_hint."""
    left = window_rect.left
    top = window_rect.top
    w = window_rect.width()
    h = window_rect.height()
    
    regions = {
        "menu_bar":   (left, top, w, min(60, h)),
        "top":        (left, top, w, h // 3),
        "top_half":   (left, top, w, h // 2),
        "bottom":     (left, top + h - min(200, h), w, min(200, h)),
        "bottom_half":(left, top + h // 2, w, h // 2),
        "sidebar":    (left, top, min(250, w), h),
        "left":       (left, top, w // 3, h),
        "right":      (left + w * 2 // 3, top, w // 3, h),
        "center":     (left + w // 4, top + h // 4, w // 2, h // 2),
        "top_left":   (left, top, min(300, w), min(300, h)),
        "top_right":  (left + w - min(300, w), top, min(300, w), min(300, h)),
    }
    
    return regions.get(hint, (left, top, w, h))  # Default: full window


def locate_via_ocr_region(
    window,
    element_text: str,
    location_hint: str = "",
) -> Optional[Dict[str, Any]]:
    """
    Tier 2: Screenshot a small region, OCR it, fuzzy-match the target text.
    Speed: ~200-500ms. RAM: ~2-5MB (tiny image).
    Returns match dict or None.
    """
    if not TESSERACT_AVAILABLE:
        return None
    
    try:
        import pytesseract
        from PIL import Image
        
        rect = window.rectangle()
        region = _get_region_rect(rect, location_hint)
        rx, ry, rw, rh = region
        
        # Ensure positive dimensions
        if rw <= 0 or rh <= 0:
            return None
        
        # Capture the region
        screenshot = pyautogui.screenshot(region=(rx, ry, rw, rh))
        
        # OCR with bounding box data
        ocr_data = pytesseract.image_to_data(screenshot, output_type=pytesseract.Output.DICT)
        
        # Build list of text items with coordinates
        ocr_items: List[Dict[str, Any]] = []
        n = len(ocr_data["text"])
        for i in range(n):
            text = ocr_data["text"][i].strip()
            conf = int(ocr_data["conf"][i])
            if not text or conf < 30:  # Skip empty/low-confidence
                continue
            # Convert local region coords to screen coords
            ocr_items.append({
                "text": text,
                "confidence": conf,
                "rect": {
                    "x": rx + ocr_data["left"][i],
                    "y": ry + ocr_data["top"][i],
                    "w": ocr_data["width"][i],
                    "h": ocr_data["height"][i],
                },
            })
        
        if not ocr_items:
            return None
        
        # Try exact substring match first
        needle = element_text.lower()
        for item in ocr_items:
            if needle == item["text"].lower() or needle in item["text"].lower():
                r = item["rect"]
                return {
                    "found": True,
                    "method": "ocr_region_exact",
                    "text": item["text"],
                    "confidence": item["confidence"],
                    "rect": r,
                    "center": {"x": r["x"] + r["w"] // 2, "y": r["y"] + r["h"] // 2},
                    "region_hint": location_hint or "full",
                }
        
        # Fuzzy match
        match = best_fuzzy_match(element_text, ocr_items, threshold=0.6)
        if match:
            r = match["rect"]
            return {
                "found": True,
                "method": "ocr_region_fuzzy",
                "text": match["text"],
                "confidence": match.get("confidence", 0),
                "fuzzy_score": match.get("_score", 0),
                "rect": r,
                "center": {"x": r["x"] + r["w"] // 2, "y": r["y"] + r["h"] // 2},
                "region_hint": location_hint or "full",
            }
        
        return None
    except Exception:
        return None


# ============================================
# SMARTNAVIGATOR: TIER 3 — FULL WINDOW OCR
# ============================================

def locate_via_full_scan(
    window,
    element_text: str,
) -> Dict[str, Any]:
    """
    Tier 3: Screenshot entire window, OCR everything, fuzzy-match.
    If no match, return the full OCR dump for LLM interpretation.
    Speed: ~1-3s. RAM: ~10-20MB peak.
    
    Returns: match dict with found=True, or dump with found=False + ocr_dump.
    """
    if not TESSERACT_AVAILABLE:
        return {
            "found": False,
            "method": "none",
            "error": f"Element '{element_text}' not found via accessibility tree. "
                     "Tesseract OCR is not installed, so Tier 2/3 OCR fallback is unavailable. "
                     "To fix: use shell.powershell to run: "
                     "choco install tesseract -y   OR   download from https://github.com/UB-Mannheim/tesseract/releases "
                     "and install to C:\\Program Files\\Tesseract-OCR\\",
            "tesseract_available": False,
            "install_hint": "shell.powershell: choco install tesseract -y",
        }
    
    try:
        import pytesseract
        from PIL import Image
        
        # Focus and capture full window
        rect = window.rectangle()
        wx, wy, ww, wh = rect.left, rect.top, rect.width(), rect.height()
        
        if ww <= 0 or wh <= 0:
            return {"found": False, "method": "ocr_full", "error": "Window has zero size"}
        
        screenshot = pyautogui.screenshot(region=(wx, wy, ww, wh))
        
        # Downscale for speed if image is very large
        max_width = 1280
        if screenshot.width > max_width:
            ratio = max_width / screenshot.width
            new_size = (max_width, int(screenshot.height * ratio))
            screenshot = screenshot.resize(new_size, Image.LANCZOS)
            scale_factor = screenshot.width / ww  # For coordinate mapping
        else:
            scale_factor = 1.0
        
        # Full OCR
        ocr_data = pytesseract.image_to_data(screenshot, output_type=pytesseract.Output.DICT)
        
        # Build OCR items
        ocr_items: List[Dict[str, Any]] = []
        n = len(ocr_data["text"])
        for i in range(n):
            text = ocr_data["text"][i].strip()
            conf = int(ocr_data["conf"][i])
            if not text or conf < 20:
                continue
            # Map back to screen coordinates
            if scale_factor != 1.0:
                ox = wx + int(ocr_data["left"][i] / scale_factor)
                oy = wy + int(ocr_data["top"][i] / scale_factor)
                ow = int(ocr_data["width"][i] / scale_factor)
                oh = int(ocr_data["height"][i] / scale_factor)
            else:
                ox = wx + ocr_data["left"][i]
                oy = wy + ocr_data["top"][i]
                ow = ocr_data["width"][i]
                oh = ocr_data["height"][i]
            
            ocr_items.append({
                "text": text,
                "confidence": conf,
                "rect": {"x": ox, "y": oy, "w": ow, "h": oh},
                "index": len(ocr_items),
            })
        
        if not ocr_items:
            return {
                "found": False,
                "method": "ocr_full",
                "error": "OCR found no text on the window",
            }
        
        # Try exact substring match
        needle = element_text.lower()
        for item in ocr_items:
            if needle == item["text"].lower() or needle in item["text"].lower():
                r = item["rect"]
                return {
                    "found": True,
                    "method": "ocr_full_exact",
                    "text": item["text"],
                    "confidence": item["confidence"],
                    "rect": r,
                    "center": {"x": r["x"] + r["w"] // 2, "y": r["y"] + r["h"] // 2},
                }
        
        # Fuzzy match
        match = best_fuzzy_match(element_text, ocr_items, threshold=0.55)
        if match:
            r = match["rect"]
            return {
                "found": True,
                "method": "ocr_full_fuzzy",
                "text": match["text"],
                "confidence": match.get("confidence", 0),
                "fuzzy_score": match.get("_score", 0),
                "rect": r,
                "center": {"x": r["x"] + r["w"] // 2, "y": r["y"] + r["h"] // 2},
            }
        
        # No match — return OCR dump for LLM interpretation (Tier 3 LLM fallback)
        # Trim to top 50 items for token budget
        ocr_dump = [{"index": it["index"], "text": it["text"], "rect": it["rect"]}
                     for it in ocr_items[:50]]
        
        return {
            "found": False,
            "method": "ocr_full_no_match",
            "error": f"OCR found {len(ocr_items)} text items but none matched '{element_text}'",
            "ocr_dump": ocr_dump,
            "ocr_item_count": len(ocr_items),
            "needs_llm": True,
        }
    
    except Exception as e:
        return {
            "found": False,
            "method": "ocr_full",
            "error": f"Full OCR scan failed: {type(e).__name__}: {str(e)}",
        }


# ============================================
# SMARTNAVIGATOR: UNIFIED SEARCH
# ============================================

def smart_find(
    window,
    element_text: str,
    element_type: str = "",
    location_hint: str = "",
) -> Dict[str, Any]:
    """
    SmartNavigator cascading fallback.
    Tier 1: UIA accessibility tree (~50ms)
    Tier 2: Regional OCR (~200-500ms, needs Tesseract)
    Tier 3: Full window OCR + fuzzy match (~1-3s, needs Tesseract)
    
    If Tier 3 finds no match either, returns the OCR dump for LLM interpretation
    (handled by the Node python-bridge.ts).
    """
    # Tier 1: Accessibility tree
    result = locate_via_accessibility(window, element_text, element_type, location_hint)
    if result:
        return result
    
    # Tier 2: Regional OCR (if location hint provided, or try common regions)
    if TESSERACT_AVAILABLE:
        if location_hint:
            result = locate_via_ocr_region(window, element_text, location_hint)
            if result:
                return result
        else:
            # Try common regions: top bar, center, then sidebar
            for hint in ["menu_bar", "center", "sidebar"]:
                result = locate_via_ocr_region(window, element_text, hint)
                if result:
                    return result
    
    # Tier 3: Full window OCR scan
    return locate_via_full_scan(window, element_text)


# ============================================
# TOOL IMPLEMENTATIONS
# ============================================

def handle_read_state(args: Dict[str, Any]) -> Dict[str, Any]:
    """gui.read_state for desktop apps — returns accessibility tree elements.
    
    mode="text" (default): Returns element list as structured data.
    mode="visual": Desktop Set-of-Marks — annotated screenshot with numbered
                   labels on each interactive element, plus element manifest.
    """
    app_name = args.get("app_name", "")
    mode = args.get("mode", "text")
    
    if not app_name:
        # Return list of all visible windows
        desktop = Desktop(backend="uia")
        windows = []
        for w in desktop.windows():
            try:
                title = w.window_text()
                if title and title.strip():
                    rect = w.rectangle()
                    windows.append({
                        "title": title,
                        "rect": {
                            "x": rect.left, "y": rect.top,
                            "w": rect.width(), "h": rect.height(),
                        },
                    })
            except Exception:
                continue
        return {
            "track": "desktop",
            "windows": windows[:30],
            "window_count": len(windows),
        }
    
    window = find_window(app_name)
    if not window:
        return {"track": "desktop", "error": f"Window '{app_name}' not found"}
    
    focus_window(window)
    elements = list_elements(window)
    window_rect = get_window_rect(window)
    
    if mode == "visual":
        return _read_state_visual(window, app_name, elements, window_rect)
    
    return {
        "track": "desktop",
        "app_name": app_name,
        "window_title": window.window_text(),
        "window_rect": window_rect,
        "elements": elements[:100],  # Cap for token savings
        "element_count": len(elements),
    }


def _read_state_visual(window, app_name: str, elements: List[Dict], window_rect: Dict) -> Dict[str, Any]:
    """Desktop Set-of-Marks: screenshot with numbered labels on interactive elements."""
    import base64
    import io
    from PIL import Image, ImageDraw, ImageFont
    
    # Take screenshot of the window
    dpi_scale = _get_dpi_scale(window)
    rect = window.rectangle()
    capture_region = (
        int(rect.left * dpi_scale),
        int(rect.top * dpi_scale),
        int(rect.width() * dpi_scale),
        int(rect.height() * dpi_scale),
    )
    screenshot = pyautogui.screenshot(region=capture_region)
    
    draw = ImageDraw.Draw(screenshot)
    
    # Try to get a small font for labels
    try:
        font = ImageFont.truetype("arial.ttf", 12)
    except Exception:
        font = ImageFont.load_default()
    
    # Assign SoM IDs and draw labels on interactive elements
    som_elements = []
    som_id = 0
    
    for el in elements:
        el_rect = el.get("rect")
        if not el_rect:
            continue
        
        # Only label interactive elements
        el_type = el.get("control_type", "").lower()
        interactive_types = {
            "button", "edit", "checkbox", "radiobutton", "combobox",
            "listitem", "menuitem", "tabitem", "link", "hyperlink",
            "slider", "spinner", "treeitem",
        }
        if el_type not in interactive_types and not el.get("text"):
            continue
        
        som_id += 1
        
        # Convert element rect (window-relative) to screenshot coords
        ex = int((el_rect["x"] - rect.left) * dpi_scale)
        ey = int((el_rect["y"] - rect.top) * dpi_scale)
        ew = int(el_rect["w"] * dpi_scale)
        eh = int(el_rect["h"] * dpi_scale)
        
        # Skip elements outside screenshot bounds
        if ex < 0 or ey < 0 or ex > screenshot.width or ey > screenshot.height:
            continue
        
        # Draw label badge: small colored rectangle with number
        badge_w = max(16, len(str(som_id)) * 8 + 6)
        badge_h = 14
        bx = max(0, min(ex, screenshot.width - badge_w))
        by = max(0, min(ey - badge_h, screenshot.height - badge_h))
        
        # Red badge with white text
        draw.rectangle([bx, by, bx + badge_w, by + badge_h], fill=(220, 38, 38))
        draw.text((bx + 3, by + 1), str(som_id), fill=(255, 255, 255), font=font)
        
        # Light outline around the element
        draw.rectangle(
            [ex, ey, min(ex + ew, screenshot.width - 1), min(ey + eh, screenshot.height - 1)],
            outline=(220, 38, 38, 128), width=1
        )
        
        som_elements.append({
            "som_id": som_id,
            "text": el.get("text", "")[:80],
            "type": el_type,
            "rect": el_rect,
        })
        
        if som_id >= 50:  # Cap at 50 labeled elements
            break
    
    # Downscale for token efficiency
    max_width = 1280
    if screenshot.width > max_width:
        ratio = max_width / screenshot.width
        new_size = (max_width, int(screenshot.height * ratio))
        screenshot = screenshot.resize(new_size, Image.LANCZOS)
    
    # Encode
    buffer = io.BytesIO()
    screenshot.save(buffer, format="JPEG", quality=65)
    image_bytes = buffer.getvalue()
    
    result = {
        "track": "desktop",
        "app_name": app_name,
        "window_title": window.window_text(),
        "window_rect": window_rect,
        "mode": "visual",
        "image_base64": base64.b64encode(image_bytes).decode("ascii"),
        "format": "jpeg",
        "width": screenshot.width,
        "height": screenshot.height,
        "file_size_kb": round(len(image_bytes) / 1024),
        "som_elements": som_elements,
        "som_count": len(som_elements),
        "som_hint": "Each red badge is a numbered element. Use gui.click(som_id=N) to click element N.",
    }
    
    # Store for som_id clicking (must be BEFORE return)
    global _last_som_elements
    _last_som_elements = som_elements
    
    return result


def handle_find_element(args: Dict[str, Any]) -> Dict[str, Any]:
    """gui.find_element for desktop — SmartNavigator cascading search."""
    app_name = args.get("app_name", "")
    element_text = args.get("element_text", "")
    element_type = args.get("element_type", "")
    location_hint = args.get("location_hint", "")
    
    if not app_name:
        return {"found": False, "error": "app_name required for desktop find_element"}
    if not element_text:
        return {"found": False, "error": "element_text required"}
    
    window = find_window(app_name)
    if not window:
        return {"found": False, "error": f"Window '{app_name}' not found"}
    
    focus_window(window)
    result = smart_find(window, element_text, element_type, location_hint)
    
    # Remove internal _element reference from output
    result.pop("_element", None)
    result["track"] = "desktop"
    return result


def handle_click(args: Dict[str, Any]) -> Dict[str, Any]:
    """gui.click for desktop — find element then click it."""
    app_name = args.get("app_name", "")
    element_text = args.get("element_text", "")
    element_type = args.get("element_type", "")
    coordinates = args.get("coordinates")
    click_type = args.get("click_type", "single")
    location_hint = args.get("location_hint", "")
    som_id = args.get("som_id")
    
    # SoM ID click — look up element from last visual read_state
    if som_id is not None:
        som_id = int(som_id)
        for sel in _last_som_elements:
            if sel["som_id"] == som_id:
                el_rect = sel["rect"]
                cx = el_rect["x"] + el_rect["w"] // 2
                cy = el_rect["y"] + el_rect["h"] // 2
                pre_state = _get_focused_info()
                _do_click(cx, cy, click_type)
                time.sleep(0.15)
                post_state = _get_focused_info()
                click_result = {
                    "clicked": True, "method": "som_id", "som_id": som_id,
                    "text": sel.get("text", ""), "x": cx, "y": cy,
                    "state_changed": (pre_state != post_state), "track": "desktop",
                }
                dialog = _check_for_dialog(app_name)
                if dialog:
                    click_result.update(dialog)
                return click_result
        return {"clicked": False, "error": f"SoM ID {som_id} not found. Run gui.read_state(mode='visual') first.", "track": "desktop"}
    
    # Direct coordinate click
    if coordinates and isinstance(coordinates, dict):
        x, y = int(coordinates["x"]), int(coordinates["y"])
        _do_click(x, y, click_type)
        return {"clicked": True, "method": "coordinates", "x": x, "y": y, "track": "desktop"}
    
    if not element_text:
        return {"clicked": False, "error": "element_text or coordinates required", "track": "desktop"}
    
    # Find the target window
    window = find_window(app_name) if app_name else None
    if app_name and not window:
        return {"clicked": False, "error": f"Window '{app_name}' not found", "track": "desktop"}
    
    if window:
        focus_window(window)
    
    # SmartNavigator search
    if window:
        result = smart_find(window, element_text, element_type, location_hint)
    else:
        # No app specified — try clicking on desktop
        result = {"found": False, "error": "No app_name specified and no window found"}
    
    if not result.get("found"):
        return {"clicked": False, "error": result.get("error", "Element not found"), "track": "desktop"}
    
    # Capture state before click for verification
    pre_state = _get_focused_info()
    
    # Click the element
    # Prefer using pywinauto's click if we have the element reference
    click_result: Optional[Dict[str, Any]] = None
    element = result.pop("_element", None)
    if element:
        try:
            element.click_input()
            click_result = {
                "clicked": True,
                "method": result["method"],
                "text": result.get("text", ""),
                "rect": result.get("rect"),
                "track": "desktop",
            }
        except Exception:
            pass
    
    # Fallback: coordinate click
    if not click_result:
        center = result.get("center")
        if center:
            _do_click(center["x"], center["y"], click_type)
            click_result = {
                "clicked": True,
                "method": result["method"] + "_coords",
                "text": result.get("text", ""),
                "x": center["x"],
                "y": center["y"],
                "track": "desktop",
            }
    
    if not click_result:
        return {"clicked": False, "error": "Found element but couldn't determine click coordinates", "track": "desktop"}
    
    # Post-action verification
    time.sleep(0.15)
    post_state = _get_focused_info()
    click_result["state_changed"] = (pre_state != post_state)
    
    # Check for unexpected dialogs
    dialog = _check_for_dialog(app_name)
    if dialog:
        click_result.update(dialog)
    
    return click_result


def _get_focused_info() -> Dict[str, Any]:
    """Capture current focused element info for pre/post action comparison."""
    try:
        desktop = Desktop(backend="uia")
        focused = desktop.get_focus()
        if focused:
            return {
                "title": focused.window_text()[:100] if focused.window_text() else "",
                "control_type": focused.friendly_class_name() if hasattr(focused, "friendly_class_name") else "",
            }
    except Exception:
        pass
    return {}


def _check_for_dialog(app_name: str) -> Optional[Dict[str, Any]]:
    """Check if an unexpected dialog appeared (save prompts, errors, UAC, etc.)."""
    dialog_keywords = [
        "do you want", "are you sure", "not responding", "has stopped",
        "save changes", "save as", "confirm", "permission",
    ]
    try:
        desktop = Desktop(backend="uia")
        for w in desktop.windows():
            try:
                title = w.window_text()
                if not title:
                    continue
                title_lower = title.lower()
                # Skip the target app window itself
                if app_name and app_name.lower() in title_lower:
                    continue
                # Only flag small windows (dialogs are typically < 800px wide)
                try:
                    r = w.rectangle()
                    if r.width() > 800 or r.height() > 600:
                        continue
                except Exception:
                    pass
                for keyword in dialog_keywords:
                    if keyword in title_lower:
                        return {
                            "dialog_detected": True,
                            "dialog_title": title,
                            "hint": "An unexpected dialog appeared. You may need to dismiss it before continuing.",
                        }
            except Exception:
                continue
    except Exception:
        pass
    return None


def _do_click(x: int, y: int, click_type: str = "single"):
    """Perform a mouse click at coordinates."""
    if click_type == "double":
        pyautogui.doubleClick(x, y)
    elif click_type == "right":
        pyautogui.rightClick(x, y)
    else:
        pyautogui.click(x, y)


def handle_type_text(args: Dict[str, Any]) -> Dict[str, Any]:
    """gui.type_text for desktop — type text into focused element or specified target."""
    app_name = args.get("app_name", "")
    text = args.get("text", "")
    target_element = args.get("target_element", "")
    press_enter = args.get("press_enter", False)
    
    if app_name:
        window = find_window(app_name)
        if window:
            focus_window(window)
        else:
            return {"typed": False, "error": f"Window '{app_name}' not found", "track": "desktop"}
    
    # Click target element first if specified
    if target_element and app_name:
        window = find_window(app_name)
        if window:
            result = smart_find(window, target_element)
            if result.get("found"):
                element = result.pop("_element", None)
                if element:
                    try:
                        element.click_input()
                        time.sleep(0.1)
                    except Exception:
                        center = result.get("center")
                        if center:
                            pyautogui.click(center["x"], center["y"])
                            time.sleep(0.1)
    
    # Type the text — use clipboard paste for non-ASCII characters
    if text:
        if all(ord(c) < 128 for c in text):
            pyautogui.write(text, interval=0.02)
        else:
            _type_via_clipboard(text)
    
    if press_enter:
        pyautogui.press("enter")
    
    return {"typed": True, "text_length": len(text), "press_enter": press_enter, "track": "desktop"}


def handle_hotkey(args: Dict[str, Any]) -> Dict[str, Any]:
    """gui.hotkey for desktop — send keyboard shortcuts."""
    app_name = args.get("app_name", "")
    keys = args.get("keys", "")
    
    if not keys:
        return {"pressed": False, "error": "No keys provided", "track": "desktop"}
    
    if app_name:
        window = find_window(app_name)
        if window:
            focus_window(window)
    
    # Parse key combo: "ctrl+t" → ["ctrl", "t"], "enter" → ["enter"]
    parts = [k.strip().lower() for k in keys.split("+")]
    
    # Map common key names
    key_map = {
        "ctrl": "ctrl",
        "control": "ctrl",
        "alt": "alt",
        "shift": "shift",
        "win": "win",
        "windows": "win",
        "super": "win",
        "enter": "enter",
        "return": "enter",
        "tab": "tab",
        "esc": "escape",
        "escape": "escape",
        "space": "space",
        "backspace": "backspace",
        "delete": "delete",
        "del": "delete",
        "up": "up",
        "down": "down",
        "left": "left",
        "right": "right",
        "home": "home",
        "end": "end",
        "pageup": "pageup",
        "pagedown": "pagedown",
    }
    
    mapped = [key_map.get(k, k) for k in parts]
    
    if len(mapped) == 1:
        pyautogui.press(mapped[0])
    else:
        pyautogui.hotkey(*mapped)
    
    return {"pressed": True, "keys": keys, "track": "desktop"}


def handle_wait_for(args: Dict[str, Any]) -> Dict[str, Any]:
    """gui.wait_for for desktop — wait for a condition."""
    condition = args.get("condition", "")
    target = args.get("target", "")
    timeout_ms = min(args.get("timeout_ms", 10000), 120000)  # Cap at 2 min
    
    start = time.time()
    timeout_s = timeout_ms / 1000.0
    poll_interval = 0.3  # Check every 300ms
    
    while (time.time() - start) < timeout_s:
        if condition == "element_visible":
            # Search across all visible windows for the target element
            desktop = Desktop(backend="uia")
            for w in desktop.windows():
                try:
                    title = w.window_text()
                    if not title or not title.strip():
                        continue
                    # Connect properly to get WindowSpecification
                    win = find_window(title)
                    if win:
                        result = locate_via_accessibility(win, target)
                        if result and result.get("found"):
                            return {"waited": True, "condition": condition, "target": target, "track": "desktop"}
                except Exception:
                    continue
        
        elif condition == "window_exists":
            window = find_window(target)
            if window:
                return {"waited": True, "condition": condition, "target": target, "track": "desktop"}
        
        elif condition == "window_title_contains":
            desktop = Desktop(backend="uia")
            for w in desktop.windows():
                try:
                    if target.lower() in w.window_text().lower():
                        return {"waited": True, "condition": condition, "target": target, "track": "desktop"}
                except Exception:
                    continue
        
        elif condition == "element_gone":
            found_anywhere = False
            desktop = Desktop(backend="uia")
            for w in desktop.windows():
                try:
                    title = w.window_text()
                    if not title or not title.strip():
                        continue
                    win = find_window(title)
                    if win:
                        result = locate_via_accessibility(win, target)
                        if result and result.get("found"):
                            found_anywhere = True
                            break
                except Exception:
                    continue
            if not found_anywhere:
                return {"waited": True, "condition": condition, "target": target, "track": "desktop"}
        
        time.sleep(poll_interval)
    
    return {
        "waited": False,
        "condition": condition,
        "target": target,
        "error": f"Timeout after {timeout_ms}ms",
        "track": "desktop",
    }


def _sanitize_url(url: str) -> Optional[str]:
    """Validate URL to prevent command injection. Returns sanitized URL or None."""
    from urllib.parse import urlparse
    # Auto-prepend https:// if no scheme
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return None
        if not parsed.netloc:
            return None
        # Block shell metacharacters in URL
        dangerous = set(';&|`$(){}[]!#')
        if any(c in url for c in dangerous):
            return None
        return url
    except Exception:
        return None


def _type_via_clipboard(text: str):
    """Type text via clipboard paste — handles non-ASCII characters."""
    import subprocess
    # Save current clipboard, set new text, paste, restore
    try:
        old_clip = subprocess.run(
            ["powershell", "-c", "Get-Clipboard"],
            capture_output=True, text=True, timeout=3
        ).stdout
    except Exception:
        old_clip = ""
    
    try:
        # Set clipboard
        subprocess.run(
            ["powershell", "-c", f"Set-Clipboard -Value '{text.replace(chr(39), chr(39)+chr(39))}'" ],
            capture_output=True, timeout=3
        )
        # Paste
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.05)
    finally:
        # Restore old clipboard
        try:
            subprocess.run(
                ["powershell", "-c", f"Set-Clipboard -Value '{old_clip.replace(chr(39), chr(39)+chr(39))}'" ],
                capture_output=True, timeout=3
            )
        except Exception:
            pass


def _add_shortcut_hints(result: Dict[str, Any], app_name: str) -> None:
    """Add available keyboard shortcuts to the navigate result."""
    app_lower = app_name.lower()
    for pattern, shortcuts in APP_SHORTCUTS.items():
        if pattern in app_lower:
            result["available_shortcuts"] = {
                action: "+".join(keys) for action, keys in shortcuts.items()
            }
            result["shortcut_hint"] = (
                "Use gui.hotkey with these shortcuts instead of clicking menus — much faster."
            )
            break


def handle_navigate(args: Dict[str, Any]) -> Dict[str, Any]:
    """gui.navigate for desktop — open app or URL via Start menu / Run dialog."""
    url = args.get("url", "")
    app_name = args.get("app_name", "")
    
    if url:
        # Sanitize URL to prevent command injection
        safe_url = _sanitize_url(url)
        if not safe_url:
            return {"navigated": False, "error": f"Invalid or blocked URL: {url}", "track": "desktop"}
        import webbrowser
        # Use webbrowser module (safe, no shell injection vector)
        webbrowser.open(safe_url)
        return {"navigated": True, "target": safe_url, "method": "url_open", "track": "desktop"}
    
    if app_name:
        # First check if the app is already running
        existing = find_window(app_name)
        if existing:
            focus_window(existing)
            title = existing.window_text()
            # Include available shortcuts for this app
            result: Dict[str, Any] = {
                "navigated": True, "target": app_name, "method": "already_running",
                "window_title": title, "track": "desktop",
            }
            _add_shortcut_hints(result, app_name)
            return result
        
        # Try launch from app database (much faster than Start menu)
        app_entry = _find_app_entry(app_name)
        exe_path = app_entry.get("exe") if app_entry else None
        launched_method = None
        if app_entry:
            # 1) Try .lnk shortcut (preserves working dir, args, env)
            lnk_path = app_entry.get("lnk")
            if lnk_path and os.path.isfile(lnk_path):
                try:
                    os.startfile(lnk_path)
                    launched_method = "shortcut"
                except Exception:
                    pass  # Fall through to direct exe
            # 2) Fall back to direct exe + cwd
            if not launched_method and exe_path:
                try:
                    import subprocess as _sp
                    exe_dir = os.path.dirname(exe_path)
                    _sp.Popen([exe_path], cwd=exe_dir, start_new_session=True)
                    launched_method = "direct_exe"
                except Exception:
                    pass  # Fall through to Start menu
        
        # Fallback: Start menu search (if no launch method succeeded)
        if not launched_method:
            pyautogui.press("win")
            time.sleep(0.5)
            if all(ord(c) < 128 for c in app_name):
                pyautogui.write(app_name, interval=0.03)
            else:
                _type_via_clipboard(app_name)
            time.sleep(0.8)
            pyautogui.press("enter")
            launched_method = "start_menu"
        
        # Wait for the window to appear (retry up to 8 seconds)
        window = None
        for attempt in range(16):
            time.sleep(0.5)
            window = find_window(app_name)
            if window:
                break
        
        if window:
            focus_window(window)
            title = window.window_text()
            result = {
                "navigated": True, "target": app_name, "method": launched_method,
                "window_title": title, "track": "desktop",
            }
            if exe_path:
                result["exe_path"] = exe_path
            _add_shortcut_hints(result, app_name)
            return result
        
        return {
            "navigated": True, "target": app_name, "method": launched_method,
            "warning": f"App launched but window not found yet. Use gui.read_state(app_name='{app_name}') to check.",
            "track": "desktop",
        }
    
    return {"navigated": False, "error": "No url or app_name provided", "track": "desktop"}


def _get_dpi_scale(window=None) -> float:
    """
    Get the DPI scale factor, with per-monitor support.
    
    If a window is provided, returns the DPI for the monitor that window is on.
    Otherwise returns the primary monitor's DPI.
    """
    try:
        import ctypes
        import ctypes.wintypes
        ctypes.windll.user32.SetProcessDPIAware()
        
        # Per-monitor DPI: find which monitor the window is on
        if window:
            try:
                rect = window.rectangle()
                # RECT struct for MonitorFromRect
                class RECT(ctypes.Structure):
                    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
                r = RECT(rect.left, rect.top, rect.right, rect.bottom)
                MONITOR_DEFAULTTONEAREST = 2
                hmon = ctypes.windll.user32.MonitorFromRect(ctypes.byref(r), MONITOR_DEFAULTTONEAREST)
                if hmon:
                    dpiX = ctypes.c_uint()
                    dpiY = ctypes.c_uint()
                    # MDT_EFFECTIVE_DPI = 0
                    hr = ctypes.windll.shcore.GetDpiForMonitor(hmon, 0, ctypes.byref(dpiX), ctypes.byref(dpiY))
                    if hr == 0 and dpiX.value > 0:
                        return dpiX.value / 96.0  # 96 DPI = 100% scale
            except Exception:
                pass
        
        # Fallback: primary monitor
        scale = ctypes.windll.shcore.GetScaleFactorForDevice(0)
        return scale / 100.0 if scale > 0 else 1.0
    except Exception:
        return 1.0


def handle_screenshot_region(args: Dict[str, Any]) -> Dict[str, Any]:
    """gui.screenshot_region for desktop — capture window screenshot with DPI handling."""
    import base64
    import io
    from PIL import Image
    
    app_name = args.get("app_name", "")
    region = args.get("region", "full")
    quality = max(1, min(args.get("quality", 60), 100))
    max_width = args.get("max_width", 1280)
    fmt = args.get("format", "jpeg").lower()
    if fmt not in ("jpeg", "png"):
        fmt = "jpeg"
    
    window = find_window(app_name) if app_name else None
    
    if app_name and not window:
        return {"error": f"Window '{app_name}' not found", "track": "desktop"}
    
    # Detect DPI scaling (per-monitor aware)
    dpi_scale = _get_dpi_scale(window)
    
    if window:
        focus_window(window)
        rect = window.rectangle()
        # Apply DPI scaling to get physical pixel coordinates
        capture_region = (
            int(rect.left * dpi_scale),
            int(rect.top * dpi_scale),
            int(rect.width() * dpi_scale),
            int(rect.height() * dpi_scale),
        )
    else:
        capture_region = None  # Full screen
    
    screenshot = pyautogui.screenshot(region=capture_region)
    
    # Apply region hint (sub-region of the window)
    if region != "full" and isinstance(region, str) and window:
        sw, sh = screenshot.width, screenshot.height
        region_map = {
            "top_half":    (0, 0, sw, sh // 2),
            "bottom_half": (0, sh // 2, sw, sh // 2),
            "left_half":   (0, 0, sw // 2, sh),
            "right_half":  (sw // 2, 0, sw // 2, sh),
            "center":      (sw // 4, sh // 4, sw // 2, sh // 2),
            "menu_bar":    (0, 0, sw, min(60, sh)),
            "sidebar":     (0, 0, min(250, sw), sh),
        }
        crop = region_map.get(region)
        if crop:
            screenshot = screenshot.crop((crop[0], crop[1], crop[0] + crop[2], crop[1] + crop[3]))
    
    # Downscale if needed (use LANCZOS for quality)
    if screenshot.width > max_width:
        ratio = max_width / screenshot.width
        new_size = (max_width, int(screenshot.height * ratio))
        screenshot = screenshot.resize(new_size, Image.LANCZOS)
    
    # Encode
    buffer = io.BytesIO()
    if fmt == "png":
        screenshot.save(buffer, format="PNG")
    else:
        screenshot.save(buffer, format="JPEG", quality=quality)
    image_bytes = buffer.getvalue()
    
    return {
        "image_base64": base64.b64encode(image_bytes).decode("ascii"),
        "width": screenshot.width,
        "height": screenshot.height,
        "file_size_kb": round(len(image_bytes) / 1024),
        "format": fmt,
        "region_captured": region,
        "dpi_scale": dpi_scale,
        "track": "desktop",
    }


# ============================================
# APP LAUNCHER DATABASE
# ============================================

# Cache: lowercase app name → {"exe": path, "lnk"?: path}
_app_db: Dict[str, Dict[str, str]] = {}
_app_db_built = False

def _build_app_db() -> None:
    """Scan Start Menu shortcuts and common paths to build app name → exe map."""
    global _app_db, _app_db_built
    if _app_db_built:
        return
    _app_db_built = True
    
    import glob
    
    # Scan Start Menu .lnk files
    lnk_dirs = [
        os.path.join(os.environ.get("PROGRAMDATA", r"C:\ProgramData"),
                     "Microsoft", "Windows", "Start Menu", "Programs"),
        os.path.join(os.environ.get("APPDATA", ""),
                     "Microsoft", "Windows", "Start Menu", "Programs"),
    ]
    
    for lnk_dir in lnk_dirs:
        if not os.path.isdir(lnk_dir):
            continue
        for lnk_path in glob.glob(os.path.join(lnk_dir, "**", "*.lnk"), recursive=True):
            try:
                target = _resolve_lnk(lnk_path)
                if target and target.lower().endswith(".exe") and os.path.isfile(target):
                    name = os.path.splitext(os.path.basename(lnk_path))[0].lower()
                    _app_db[name] = {"exe": target, "lnk": lnk_path}
            except Exception:
                continue
    
    # Also scan Program Files for common patterns
    for pf in [os.environ.get("PROGRAMFILES", r"C:\Program Files"),
               os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")]:
        if not pf or not os.path.isdir(pf):
            continue
        for entry in os.listdir(pf):
            app_dir = os.path.join(pf, entry)
            if not os.path.isdir(app_dir):
                continue
            # Look for exe in folder (up to 2 levels deep)
            folder_lower = entry.lower()
            for root, dirs, files in os.walk(app_dir):
                # Limit depth to 2 levels
                depth = root.replace(app_dir, "").count(os.sep)
                if depth > 2:
                    dirs.clear()
                    continue
                for f in files:
                    if f.lower().endswith(".exe") and not f.lower().startswith("unins"):
                        _app_db.setdefault(folder_lower, {"exe": os.path.join(root, f)})
                        break
                if folder_lower in _app_db:
                    break


def _resolve_lnk(lnk_path: str) -> Optional[str]:
    """Resolve a Windows .lnk shortcut to its target path using PowerShell."""
    try:
        import subprocess as _sp
        # Escape single quotes in path to prevent PowerShell injection
        safe_path = lnk_path.replace("'", "''")
        result = _sp.run(
            ["powershell", "-NoProfile", "-c",
             f"(New-Object -ComObject WScript.Shell).CreateShortcut('{safe_path}').TargetPath"],
            capture_output=True, text=True, timeout=3
        )
        target = result.stdout.strip()
        return target if target else None
    except Exception:
        return None


def _find_app_entry(app_name: str) -> Optional[Dict[str, str]]:
    """Look up an app name in the launcher database. Returns {"exe": path, "lnk"?: path} or None."""
    _build_app_db()
    app_lower = app_name.lower().strip()
    
    # Exact match
    if app_lower in _app_db:
        return _app_db[app_lower]
    
    # Partial match: app_name is a substring of a known app (or vice versa)
    # Require minimum 4 chars to avoid tiny substring false positives
    if len(app_lower) >= 4:
        for name, entry in _app_db.items():
            if app_lower in name or (len(name) >= 4 and name in app_lower):
                return entry
    
    # Word match: first word of app_name matches start of a known app name
    words = app_lower.split()
    if words:
        primary = words[0]
        if len(primary) >= 3:
            for name, entry in _app_db.items():
                # Require word-boundary match: name starts with primary, or
                # primary matches a whole hyphenated/spaced segment
                name_parts = name.replace("-", " ").split()
                if name.startswith(primary) or primary in name_parts:
                    return entry
    
    return None


# ============================================
# KEYBOARD SHORTCUTS DATABASE
# ============================================

# Common keyboard shortcuts by app name pattern.
# Used to perform actions faster than navigating menus.
APP_SHORTCUTS: Dict[str, Dict[str, List[str]]] = {
    "obs": {
        "start recording": ["ctrl", "shift", "1"],
        "stop recording": ["ctrl", "shift", "1"],
        "start streaming": ["ctrl", "shift", "2"],
        "stop streaming": ["ctrl", "shift", "2"],
        "pause recording": ["ctrl", "shift", "3"],
        "toggle mute": ["ctrl", "shift", "m"],
    },
    "notepad++": {
        "new file": ["ctrl", "n"],
        "save": ["ctrl", "s"],
        "find": ["ctrl", "f"],
        "replace": ["ctrl", "h"],
        "close tab": ["ctrl", "w"],
    },
    "vlc": {
        "play": ["space"],
        "pause": ["space"],
        "fullscreen": ["f"],
        "volume up": ["ctrl", "up"],
        "volume down": ["ctrl", "down"],
        "mute": ["m"],
    },
    "vscode": {
        "open terminal": ["ctrl", "`"],
        "command palette": ["ctrl", "shift", "p"],
        "save": ["ctrl", "s"],
        "find": ["ctrl", "f"],
        "go to file": ["ctrl", "p"],
    },
    "chrome": {
        "new tab": ["ctrl", "t"],
        "close tab": ["ctrl", "w"],
        "reload": ["ctrl", "r"],
        "dev tools": ["f12"],
        "address bar": ["ctrl", "l"],
    },
    "explorer": {
        "new folder": ["ctrl", "shift", "n"],
        "address bar": ["alt", "d"],
        "search": ["ctrl", "e"],
        "rename": ["f2"],
        "delete": ["delete"],
    },
}


def find_shortcut(app_name: str, action: str) -> Optional[List[str]]:
    """Find a keyboard shortcut for an action in a known app."""
    app_lower = app_name.lower()
    action_lower = action.lower().strip()
    
    for pattern, shortcuts in APP_SHORTCUTS.items():
        if pattern in app_lower:
            # Exact action match
            if action_lower in shortcuts:
                return shortcuts[action_lower]
            # Fuzzy action match
            for shortcut_action, keys in shortcuts.items():
                if action_lower in shortcut_action or shortcut_action in action_lower:
                    return keys
    return None


# ============================================
# SESSION STATE (persists across calls in daemon mode)
# ============================================

# Cache of known windows: app_name → { pid, handle, title, last_seen }
_window_cache: Dict[str, Dict[str, Any]] = {}

# Last Set-of-Marks elements from visual read_state (for som_id clicking)
_last_som_elements: List[Dict[str, Any]] = []

def _cache_window(app_name: str, window) -> None:
    """Cache a found window for reuse on follow-up calls."""
    try:
        _window_cache[app_name.lower()] = {
            "handle": window.handle,
            "title": window.window_text(),
            "pid": window.process_id() if hasattr(window, "process_id") else 0,
            "last_seen": time.time(),
        }
    except Exception:
        pass

def _get_cached_window(app_name: str):
    """Try to reconnect to a cached window. Returns WindowSpecification or None."""
    key = app_name.lower()
    cached = _window_cache.get(key)
    if not cached:
        return None
    # Expire after 60 seconds
    if time.time() - cached["last_seen"] > 60:
        del _window_cache[key]
        return None
    try:
        app = Application(backend="uia").connect(handle=cached["handle"])
        dlg = app.top_window()
        if dlg.exists(timeout=0.3):
            cached["last_seen"] = time.time()
            return dlg
    except Exception:
        del _window_cache[key]
    return None


# ============================================
# MAIN DISPATCHER
# ============================================

TOOL_HANDLERS = {
    "gui.read_state": handle_read_state,
    "gui.find_element": handle_find_element,
    "gui.click": handle_click,
    "gui.type_text": handle_type_text,
    "gui.hotkey": handle_hotkey,
    "gui.wait_for": handle_wait_for,
    "gui.navigate": handle_navigate,
    "gui.screenshot_region": handle_screenshot_region,
}


def dispatch(tool_id: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a tool and return the result dict."""
    handler = TOOL_HANDLERS.get(tool_id)
    if not handler:
        return {"error": f"Unknown desktop tool: {tool_id}"}
    
    try:
        result = handler(args)
        
        # Cache the window for session reuse (use cached lookup, don't re-scan)
        app_name = args.get("app_name", "")
        if app_name and isinstance(result, dict) and not result.get("error"):
            cached = _get_cached_window(app_name)
            if not cached:
                window = find_window(app_name)
                if window:
                    _cache_window(app_name, window)
        
        return result
    except Exception as e:
        return {
            "error": f"[{tool_id}] {type(e).__name__}: {str(e)}",
            "traceback": traceback.format_exc(),
        }


def run_daemon():
    """
    Daemon mode: read JSON-RPC commands from stdin, write responses to stdout.
    
    Protocol (newline-delimited JSON):
    → {"id": "xxx", "tool": "gui.click", "args": {...}}\n
    ← {"id": "xxx", "result": {...}}\n
    
    Special commands:
    → {"id": "xxx", "tool": "_ping"}\n
    ← {"id": "xxx", "result": {"pong": true}}\n
    
    → {"id": "xxx", "tool": "_cache"}\n
    ← {"id": "xxx", "result": {"windows": [...]}}\n
    """
    # Signal ready
    sys.stdout.write(json.dumps({"ready": True, "pid": os.getpid()}) + "\n")
    sys.stdout.flush()
    
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            sys.stdout.write(json.dumps({"error": "Invalid JSON"}) + "\n")
            sys.stdout.flush()
            continue
        
        msg_id = msg.get("id", "")
        tool_id = msg.get("tool", "")
        args = msg.get("args", {})
        
        # Special commands
        if tool_id == "_ping":
            response = {"id": msg_id, "result": {"pong": True}}
        elif tool_id == "_cache":
            response = {"id": msg_id, "result": {
                "windows": {k: {"title": v["title"], "pid": v["pid"]} 
                            for k, v in _window_cache.items()},
            }}
        elif tool_id == "_quit":
            sys.stdout.write(json.dumps({"id": msg_id, "result": {"quit": True}}) + "\n")
            sys.stdout.flush()
            break
        else:
            result = dispatch(tool_id, args)
            response = {"id": msg_id, "result": result}
        
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


def run_oneshot():
    """Legacy one-shot mode: single tool call via CLI args."""
    parser = argparse.ArgumentParser(description="DotBot Desktop GUI Agent")
    parser.add_argument("--tool", required=True, help="Tool ID (e.g., gui.click)")
    parser.add_argument("--args", required=True, help="JSON-encoded arguments")
    parsed = parser.parse_args()
    
    tool_id = parsed.tool
    try:
        args = json.loads(parsed.args)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON args: {e}"}))
        sys.exit(1)
    
    result = dispatch(tool_id, args)
    print(json.dumps(result))
    if result.get("error"):
        sys.exit(1)


def main():
    if "--daemon" in sys.argv:
        run_daemon()
    else:
        run_oneshot()


if __name__ == "__main__":
    main()
