// ReadWithMe - content.js
// Runs on every page and implements all of the extension's behaviors:
//   1. Typography & Tints  -> <style id="rwm-typography"> with !important
//                             (including high-contrast text + link colors)
//   2. Focus Window        -> #rwm-focus-overlay (feathered edges), resized
//                             on mousemove
//   3. Calm Mode            -> .rwm-calm-active added to <body>; CSS only
//                             hides clutter, layout is never modified
//   4. Syllable Splitter    -> #rwm-tooltip, shown on mouseup/selectionchange
//   5. AI Copilot           -> #rwm-copilot-badge / #rwm-copilot-drawer
//   6. Quick Toolbar        -> #rwm-quick-toolbar (Focus Window / Calm Mode /
//                             Dark Mode / Read Aloud toggles synced via
//                             chrome.storage.sync)
//   7. Theme                -> data-rwm-theme="light|dark" on <html> themes
//                             every extension widget
//   8. Page Theme           -> Light/Dark Mode applied to the webpage itself
//                             (data-rwm-page + per-element tags, reversible)
//   9. Read Aloud (TTS)     -> Cursor hover read-aloud using Web Speech API

(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    font: "lexend",
    fontSize: 18,
    lineHeight: 1.6,
    letterSpacing: 0.05,
    bgTint: "none",
    focusWindow: false,
    calmMode: false,
    theme: "light",
    themePages: true,
    readAloud: false,
    readAloudVoice: "",
    readAloudSpeed: 1.0
  };

  // Elements the extension restyles for typography and text color:
  // p, span, article, li, and h1-h6. Links (a) get their own color rule.
  const TEXT_TAGS = ["p", "span", "article", "li", "h1", "h2", "h3", "h4", "h5", "h6"];

  // Readable text tags for Read-Aloud hover detection.
  const READABLE_TAGS = new Set(["P", "SPAN", "ARTICLE", "LI", "H1", "H2", "H3", "H4", "H5", "H6"]);

  // Every element the extension injects carries the .rwm-ui class. Page-wide
  // text rules exclude anything inside it, so the extension's own tooltip,
  // copilot drawer, and toolbar never inherit the page's forced colors/fonts.
  const NOT_RWM_UI = ":not(.rwm-ui *)";

  const TEXT_COLOR = "#1A1A1A";
  const LINK_COLOR = "#1E56A0";
  const LINK_HOVER_COLOR = "#123F7A";

  const FONT_STACKS = {
    lexend: "'Lexend', sans-serif",
    opendyslexic: "'OpenDyslexic', Arial, sans-serif",
    arial: "Arial, Helvetica, sans-serif"
  };

  let currentSettings = { ...DEFAULT_SETTINGS };

  // ======================================================================
  // FEATURE 1: Typography & Tints
  // ======================================================================
  // Builds (or updates) a single <style id="rwm-typography"> tag whose
  // rules carry !important, so they win over virtually any site stylesheet.
  // Every slider/dropdown change in the popup re-runs this function with the
  // new values, so the page updates live with no reload required.

  let typographyStyleEl = null;

  function getTypographyStyleEl() {
    if (typographyStyleEl && document.documentElement.contains(typographyStyleEl)) {
      return typographyStyleEl;
    }
    typographyStyleEl = document.getElementById("rwm-typography");
    if (!typographyStyleEl) {
      typographyStyleEl = document.createElement("style");
      typographyStyleEl.id = "rwm-typography";
      (document.head || document.documentElement).appendChild(typographyStyleEl);
    }
    return typographyStyleEl;
  }

  // Returns true when the page's own background is dark (so forcing dark
  // text on it would make things unreadable instead of more readable).
  function pageHasDarkBackground() {
    function readOpaqueBackground(el) {
      if (!el) return null;
      const raw = window.getComputedStyle(el).backgroundColor || "";
      const match = raw.match(/\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      if (parts.length < 3 || parts.slice(0, 3).some((n) => isNaN(n))) return null;
      const alpha = parts.length > 3 ? parts[3] : 1;
      if (alpha < 0.5) return null; // effectively transparent
      return parts;
    }

    let rgb = readOpaqueBackground(document.body) || readOpaqueBackground(document.documentElement);
    if (!rgb) {
      // Body and <html> are transparent: many sites paint the background on
      // a wrapper. Walk up from whatever sits at the center of the screen.
      let node = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
      while (node && !rgb) {
        rgb = readOpaqueBackground(node);
        node = node.parentElement;
      }
    }
    if (!rgb) return false; // transparent everywhere -> browsers paint white
    const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    return luminance < 0.4;
  }

  // The page's ORIGINAL darkness is measured once, before any theming is
  // applied, so toggling themes never confuses the detector.
  let originalPageDark = null;

  function isOriginalPageDark() {
    if (originalPageDark === null) originalPageDark = pageHasDarkBackground();
    return originalPageDark;
  }

  // Decides how the webpage itself is themed:
  //   "dark"  -> Dark Mode on a light page: flip light surfaces/dark text
  //   "light" -> Light Mode on a natively dark page: flip dark surfaces/light text
  //   null    -> leave the page's own colors alone (already matches the theme,
  //              or "Apply theme to webpages" is switched off)
  function getPageMode(settings) {
    if (!settings.themePages) return null;
    if (settings.theme === "dark") return isOriginalPageDark() ? null : "dark";
    return isOriginalPageDark() ? "light" : null;
  }

  // A background tint only applies in Light Mode (or when page theming is
  // off); Dark Mode owns the page background.
  function isTintActive(settings) {
    const hasTint = settings.bgTint && settings.bgTint !== "none";
    return !!hasTint && (settings.theme === "light" || !settings.themePages);
  }

  // Dark text is enforced on normal light pages. It is skipped on natively
  // dark pages (dark-on-dark would be unreadable) unless a tint is active,
  // and whenever the page-theme engine is already recoloring the page.
  function shouldEnforceTextColor(settings, pageMode) {
    if (pageMode) return false;
    if (isTintActive(settings)) return true;
    return !isOriginalPageDark();
  }

  function buildTypographyCss(settings) {
    const fontStack = FONT_STACKS[settings.font] || FONT_STACKS.lexend;
    const textSelector = TEXT_TAGS.map((tag) => `${tag}${NOT_RWM_UI}`).join(", ");
    const pageMode = getPageMode(settings);
    const tintActive = isTintActive(settings);

    let css = `
      ${textSelector} {
        font-family: ${fontStack} !important;
        font-size: ${settings.fontSize}px !important;
        line-height: ${settings.lineHeight} !important;
        letter-spacing: ${settings.letterSpacing}em !important;
      }
    `;

    if (pageMode) {
      // Page theme. content.js tags elements with data-rwm-bg / -fg / -bd /
      // -link only when their ORIGINAL colors clash with the target theme,
      // so intentionally colored elements (buttons, badges, charts) keep
      // their colors.
      const P = pageMode === "dark"
        ? { bg: "#121212", surface: "#1E1E1E", text: "#E0E0E0", border: "#333333", link: "#8AB4F8", scheme: "dark" }
        : { bg: tintActive ? settings.bgTint : "#FFFFFF", surface: "#F5F5F5", text: "#1A1A1A", border: "#D0D0D0", link: LINK_COLOR, scheme: "light" };
      css += `
        html, html body {
          background-color: ${P.bg} !important;
          background-image: none !important;
          color: ${P.text} !important;
          color-scheme: ${P.scheme};
          transition: background-color 0.25s ease !important;
        }
        html [data-rwm-bg] { background-color: ${P.surface} !important; }
        html [data-rwm-fg] { color: ${P.text} !important; }
        html [data-rwm-bd] { border-color: ${P.border} !important; }
        html a[data-rwm-link], html a[data-rwm-link]:visited {
          color: ${P.link} !important;
          text-decoration: underline !important;
        }
      `;
    } else if (tintActive) {
      css += `
        html, body {
          background-color: ${settings.bgTint} !important;
          background-image: none !important;
          transition: background-color 0.25s ease !important;
        }
      `;
    }

    if (shouldEnforceTextColor(settings, pageMode)) {
      // High-contrast body text (#1A1A1A on the light tints is well above
      // the WCAG AAA 7:1 ratio).
      css += `
        ${textSelector} {
          color: ${TEXT_COLOR} !important;
        }
      `;

      // Links stay clearly distinguishable: accessible blue + underline.
      // Elements nested inside a link (e.g. <a><span>text</span></a>) are
      // re-colored to the link color so they don't turn dark like body text.
      const linkChildSelector = TEXT_TAGS.map((tag) => `a${NOT_RWM_UI} ${tag}${NOT_RWM_UI}`).join(", ");
      css += `
        a${NOT_RWM_UI}, a${NOT_RWM_UI}:visited {
          color: ${LINK_COLOR} !important;
          text-decoration: underline !important;
        }
        a${NOT_RWM_UI}:hover, a${NOT_RWM_UI}:focus {
          color: ${LINK_HOVER_COLOR} !important;
        }
        ${linkChildSelector} {
          color: inherit !important;
        }
      `;
    }

    return css;
  }

  function applyTypographyAndTint(settings) {
    const styleEl = getTypographyStyleEl();
    styleEl.textContent = buildTypographyCss(settings);
  }

  // ======================================================================
  // FEATURE 2: Focus Window
  // ======================================================================
  // Creates a single #rwm-focus-overlay container holding two absolutely
  // positioned child panels (.rwm-focus-panel-top / .rwm-focus-panel-bottom).
  // A mousemove listener recomputes both panels' heights on every move so
  // the clear "window" between them tracks the cursor in real time. Both
  // panels (and the container) have pointer-events: none in content.css, so
  // the overlay never blocks clicks, text selection, or scrolling.
  //
  // TOUCH SUPPORT: touchstart and touchmove listeners are attached alongside
  // mousemove so the illuminated reading band follows the user's finger on
  // touchscreens (using event.touches[0].clientY). Both are passive so they
  // never block scrolling.
  //
  // PERFORMANCE: The mousemove handler is throttled via requestAnimationFrame
  // so panel updates are batched to the display refresh rate (~60fps) and
  // never cause layout thrashing during rapid mouse movement.

  let focusOverlayEl = null;
  let focusTopPanelEl = null;
  let focusBottomPanelEl = null;
  let focusMouseMoveHandler = null;
  let focusTouchHandler = null;

  function createFocusOverlay() {
    if (focusOverlayEl && document.documentElement.contains(focusOverlayEl)) {
      return { overlay: focusOverlayEl, top: focusTopPanelEl, bottom: focusBottomPanelEl };
    }

    focusOverlayEl = document.createElement("div");
    focusOverlayEl.id = "rwm-focus-overlay";
    focusOverlayEl.className = "rwm-ui";
    focusOverlayEl.setAttribute("aria-hidden", "true");

    focusTopPanelEl = document.createElement("div");
    focusTopPanelEl.className = "rwm-focus-panel-top";

    focusBottomPanelEl = document.createElement("div");
    focusBottomPanelEl.className = "rwm-focus-panel-bottom";

    focusOverlayEl.appendChild(focusTopPanelEl);
    focusOverlayEl.appendChild(focusBottomPanelEl);
    document.documentElement.appendChild(focusOverlayEl);

    return { overlay: focusOverlayEl, top: focusTopPanelEl, bottom: focusBottomPanelEl };
  }

  function updateFocusWindowPosition(clientY) {
    if (!focusTopPanelEl || !focusBottomPanelEl) return;
    // The clear "window" is sized to roughly two lines of the current
    // font-size/line-height, with a sensible floor for very small fonts.
    // The soft edges are drawn by CSS (mask-image gradients over the dimmed
    // side of each panel, see content.css), so the panels still meet the
    // clear band exactly at windowTop / windowBottom and the band itself
    // stays fully clear while the dim fades in smoothly around it.
    const bandHeight = Math.max(60, currentSettings.fontSize * currentSettings.lineHeight * 2);
    const windowTop = Math.max(0, clientY - bandHeight / 2);
    const windowBottom = Math.min(window.innerHeight, windowTop + bandHeight);

    focusTopPanelEl.style.top = "0px";
    focusTopPanelEl.style.height = `${windowTop}px`;

    focusBottomPanelEl.style.top = `${windowBottom}px`;
    focusBottomPanelEl.style.height = `${Math.max(0, window.innerHeight - windowBottom)}px`;
  }

  function enableFocusWindow() {
    const { overlay } = createFocusOverlay();
    overlay.classList.add("rwm-active");

    if (!focusMouseMoveHandler) {
      let rafId = 0;
      focusMouseMoveHandler = (event) => {
        const clientY = event.clientY;
        if (rafId) return; // already scheduled
        rafId = window.requestAnimationFrame(() => {
          updateFocusWindowPosition(clientY);
          rafId = 0;
        });
      };
      document.addEventListener("mousemove", focusMouseMoveHandler, { passive: true });
    }

    // Touch support: touchstart + touchmove track the user's finger on
    // mobile so the Focus Window band follows touch input just like it
    // follows the mouse cursor on desktop.
    if (!focusTouchHandler) {
      let rafIdTouch = 0;
      focusTouchHandler = (event) => {
        if (!event.touches || event.touches.length === 0) return;
        const clientY = event.touches[0].clientY;
        if (rafIdTouch) return;
        rafIdTouch = window.requestAnimationFrame(() => {
          updateFocusWindowPosition(clientY);
          rafIdTouch = 0;
        });
      };
      document.addEventListener("touchstart", focusTouchHandler, { passive: true });
      document.addEventListener("touchmove", focusTouchHandler, { passive: true });
    }

    // Draw an initial window immediately (centered vertically) instead of
    // waiting for the first mouse movement after the toggle is switched on.
    updateFocusWindowPosition(window.innerHeight / 2);
  }

  function disableFocusWindow() {
    if (focusOverlayEl) focusOverlayEl.classList.remove("rwm-active");
    if (focusMouseMoveHandler) {
      document.removeEventListener("mousemove", focusMouseMoveHandler);
      focusMouseMoveHandler = null;
    }
    if (focusTouchHandler) {
      document.removeEventListener("touchstart", focusTouchHandler);
      document.removeEventListener("touchmove", focusTouchHandler);
      focusTouchHandler = null;
    }
  }

  // ======================================================================
  // Shared DOM helpers (used by the Page Theme engine and Calm Mode)
  // ======================================================================

  // Processes a long list of elements in small chunks so big pages never
  // freeze. Uses requestIdleCallback when available, otherwise setTimeout.
  // isCurrent() lets a newer run cancel an older one.
  const scheduleChunk = typeof window.requestIdleCallback === "function"
    ? (fn) => window.requestIdleCallback(fn, { timeout: 100 })
    : (fn) => window.setTimeout(fn, 0);

  function runChunked(list, fn, isCurrent, onDone) {
    let i = 0;
    function step() {
      if (!isCurrent()) return;
      const end = Math.min(i + 400, list.length);
      for (; i < end; i++) {
        try { fn(list[i]); } catch (err) { /* skip elements that cannot be read */ }
      }
      if (i < list.length) {
        scheduleChunk(step);
      } else if (onDone) {
        onDone();
      }
    }
    step();
  }

  // The root element plus its descendants, capped for very large pages.
  function collectElements(root, cap) {
    const out = [];
    if (!root || root.nodeType !== 1) return out;
    out.push(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (out.length < cap && walker.nextNode()) out.push(walker.currentNode);
    return out;
  }

  function parseCssColor(value) {
    if (!value) return null;
    const match = value.match(/\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function colorLuminance(c) {
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }

  // One MutationObserver serves both features: it watches for elements the
  // page adds later (lazy content, late cookie banners) and hands them to
  // the page-theme scanner and/or the Calm Mode scanner.
  //
  // PERFORMANCE: The MutationObserver callback is debounced with a 300ms
  // delay so dynamic pages (infinite scroll, live feeds) never cause
  // stuttering. Pending nodes are collected into a Set and flushed in one
  // pass after the debounce settles.
  let activePageMode = null;
  let pageScanToken = 0;
  let calmActive = false;
  let calmScanToken = 0;
  let calmBaselineText = 0;
  let calmNeedsUnlock = false;
  let domObserver = null;
  let pendingNodes = new Set();
  let pendingTimer = null;

  function ensureDomObserver() {
    const needed = !!activePageMode || calmActive;
    if (needed && !domObserver && document.body) {
      domObserver = new MutationObserver((mutations) => {
        mutations.forEach((m) => {
          m.addedNodes.forEach((n) => {
            if (n.nodeType === 1) pendingNodes.add(n);
          });
        });
        if (pendingNodes.size > 0) {
          // Debounce: reset the timer on every mutation batch so we only
          // flush once 300ms have elapsed without new mutations.
          if (pendingTimer) window.clearTimeout(pendingTimer);
          pendingTimer = window.setTimeout(flushPendingNodes, 300);
        }
      });
      domObserver.observe(document.body, { childList: true, subtree: true });
    } else if (!needed && domObserver) {
      domObserver.disconnect();
      domObserver = null;
      pendingNodes.clear();
      if (pendingTimer) {
        window.clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }
  }

  function flushPendingNodes() {
    pendingTimer = null;
    let nodes = Array.from(pendingNodes).filter((n) => n.isConnected);
    pendingNodes.clear();
    // Drop nodes already covered by an added ancestor.
    nodes = nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
    nodes.slice(0, 200).forEach((node) => {
      if (activePageMode) {
        const mode = activePageMode;
        const token = pageScanToken;
        runChunked(collectElements(node, 3000), (el) => scanElementForTheme(el, mode), () => token === pageScanToken);
      }
      if (calmActive) {
        const token = calmScanToken;
        runChunked(collectElements(node, 3000), evaluateCalmFloating, () => token === calmScanToken, applyCalmUnlock);
      }
    });
  }

  // ======================================================================
  // FEATURE 8: Page Theme (Light / Dark Mode for the webpage itself)
  // ======================================================================
  // Instead of blanket-overriding every element (which would flatten
  // buttons, badges, and charts), this scans each element's computed colors
  // and tags ONLY the ones that clash with the target theme:
  //   data-rwm-bg   light surface (Dark Mode) / dark surface (Light Mode)
  //   data-rwm-fg   dark text (Dark Mode) / light text (Light Mode)
  //   data-rwm-bd   light borders (Dark Mode) / dark borders (Light Mode)
  //   data-rwm-link links whose color is unreadable on the new background
  // The CSS that recolors tagged elements is generated in buildTypographyCss.
  // Turning the theme off removes every tag, restoring the page exactly.

  const THEME_SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IMG", "VIDEO", "CANVAS", "IFRAME", "META", "LINK",
    "HEAD", "TEMPLATE", "BR", "HR", "SOURCE", "TRACK", "PICTURE", "AUDIO", "OBJECT",
    "EMBED", "AREA", "MAP"
  ]);

  function shouldSkipThemeElement(el) {
    if (el === document.body || el === document.documentElement) return true;
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") return true; // SVG etc.
    if (THEME_SKIP_TAGS.has(el.tagName)) return true;
    if (el.closest && el.closest(".rwm-ui")) return true;
    return false;
  }

  function scanElementForTheme(el, mode) {
    if (shouldSkipThemeElement(el)) return;
    const toDark = mode === "dark";
    const cs = window.getComputedStyle(el);

    const bg = parseCssColor(cs.backgroundColor);
    if (bg && bg.a >= 0.5) {
      const l = colorLuminance(bg);
      if (toDark ? l > 0.6 : l < 0.4) el.setAttribute("data-rwm-bg", "1");
    }

    const fg = parseCssColor(cs.color);
    if (fg) {
      const l = colorLuminance(fg);
      if (toDark ? l < 0.5 : l > 0.6) {
        el.setAttribute(el.tagName === "A" ? "data-rwm-link" : "data-rwm-fg", "1");
      }
    }

    const sides = ["Top", "Right", "Bottom", "Left"];
    for (let i = 0; i < sides.length; i++) {
      const side = sides[i];
      if (parseFloat(cs["border" + side + "Width"]) > 0 && cs["border" + side + "Style"] !== "none") {
        const bc = parseCssColor(cs["border" + side + "Color"]);
        if (bc && bc.a >= 0.3) {
          const l = colorLuminance(bc);
          if (toDark ? l > 0.6 : l < 0.4) {
            el.setAttribute("data-rwm-bd", "1");
            break;
          }
        }
      }
    }
  }

  function clearPageTheme() {
    pageScanToken++;
    document.documentElement.removeAttribute("data-rwm-page");
    document.querySelectorAll("[data-rwm-bg], [data-rwm-fg], [data-rwm-bd], [data-rwm-link]").forEach((el) => {
      el.removeAttribute("data-rwm-bg");
      el.removeAttribute("data-rwm-fg");
      el.removeAttribute("data-rwm-bd");
      el.removeAttribute("data-rwm-link");
    });
  }

  function applyPageTheme(mode) {
    if (mode === activePageMode) return;
    clearPageTheme();
    activePageMode = mode;
    if (!mode || !document.body) {
      ensureDomObserver();
      return;
    }
    document.documentElement.setAttribute("data-rwm-page", mode);
    const token = ++pageScanToken;
    runChunked(
      collectElements(document.body, 20000),
      (el) => scanElementForTheme(el, mode),
      () => token === pageScanToken
    );
    ensureDomObserver();
  }

  // ======================================================================
  // FEATURE 3: Calm Mode (non-destructive, stronger decluttering)
  // ======================================================================
  // Calm Mode never changes layout, margins, widths, colors, or fonts. It
  // adds .rwm-calm-active to <body>; content.css then hides known clutter
  // (ads, cookie notices, popups, sidebars, recommendations, chat widgets,
  // comments...). On top of those selectors, content.js finds clutter that
  // has no telltale class name: elements that are position: fixed or sticky
  // (floating bars, popups, cookie walls). It tags them with
  // data-rwm-calm-hidden and CSS hides them with display: none.
  //
  // SAFETY: Calm Mode also protects structural flex/grid containers. Before
  // tagging a fixed/sticky element, we verify it is not a critical layout
  // container (display: flex, grid, inline-flex, inline-grid) that holds
  // the main content.
  //
  // Safeguards:
  //   - Fixed/sticky elements containing the main article, a search box, or
  //     a whole-page app shell are never hidden.
  //   - If hiding makes most of the page's text vanish, the extended rules
  //     are switched off (.rwm-calm-safe) and only the core rules remain.
  //   - If a full-screen overlay was hidden, page scrolling is unlocked.

  const CALM_SEARCH_SELECTOR =
    'input[type="search"], [role="search"], [role="searchbox"], input[name="q"], ' +
    'input[name="field-keywords"], input[aria-label*="search" i]';

  const CALM_SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "HEAD", "META", "LINK", "TEMPLATE",
    "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD"
  ]);

  function visibleTextLength() {
    return document.body ? (document.body.innerText || "").length : 0;
  }

  function evaluateCalmFloating(el) {
    if (el === document.body || el === document.documentElement) return;
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
    if (CALM_SKIP_TAGS.has(el.tagName)) return;
    if (el.closest && el.closest(".rwm-ui")) return;

    const cs = window.getComputedStyle(el);
    const pos = cs.position;
    if (pos !== "fixed" && pos !== "sticky") return;
    if (cs.display === "none" || cs.visibility === "hidden") return;
    if (el.closest("[data-rwm-calm-hidden]")) return;

    // Never hide something that holds the article or a search box.
    if (el.querySelector("main, article, [role='main']")) return;
    if (el.matches(CALM_SEARCH_SELECTOR) || el.querySelector(CALM_SEARCH_SELECTOR)) return;

    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.width < 1 || rect.height < 1) return;

    // A full-screen container holding lots of text is an app shell, not a popup.
    const coversMost = rect.width >= vw * 0.9 && rect.height >= vh * 0.9;
    if (coversMost && (el.textContent || "").length > 1500) return;

    // Sticky elements are only treated as clutter when they are wide, short bars.
    if (pos === "sticky" && (rect.height > vh * 0.5 || rect.width < vw * 0.5)) return;

    el.setAttribute("data-rwm-calm-hidden", "true");
    if (rect.width * rect.height >= vw * vh * 0.6) calmNeedsUnlock = true;
  }

  function applyCalmUnlock() {
    if (calmActive && calmNeedsUnlock) {
      document.documentElement.classList.add("rwm-calm-unlock");
    }
  }

  function clearCalmMarks() {
    document.querySelectorAll("[data-rwm-calm-hidden]").forEach((el) => el.removeAttribute("data-rwm-calm-hidden"));
  }

  function calmSafetyCheck() {
    if (!calmActive || !document.body) return;
    const now = visibleTextLength();
    if (calmBaselineText > 800 && now < calmBaselineText * 0.3) {
      document.body.classList.add("rwm-calm-safe");
      clearCalmMarks();
    }
  }

  function enableCalmMode() {
    if (!document.body || calmActive) return;
    calmActive = true;
    calmNeedsUnlock = false;
    calmBaselineText = visibleTextLength();
    document.body.classList.remove("rwm-calm-safe");
    document.body.classList.add("rwm-calm-active");
    calmSafetyCheck();

    const token = ++calmScanToken;
    runChunked(
      collectElements(document.body, 20000),
      evaluateCalmFloating,
      () => token === calmScanToken,
      () => {
        applyCalmUnlock();
        calmSafetyCheck();
      }
    );
    ensureDomObserver();
  }

  function disableCalmMode() {
    if (!calmActive) {
      if (document.body) document.body.classList.remove("rwm-calm-active", "rwm-calm-safe");
      return;
    }
    calmActive = false;
    calmScanToken++;
    if (document.body) document.body.classList.remove("rwm-calm-active", "rwm-calm-safe");
    document.documentElement.classList.remove("rwm-calm-unlock");
    clearCalmMarks();
    ensureDomObserver();
  }

  // ======================================================================
  // FEATURE 4: Syllable Splitter & Jargon Simplifier
  // ======================================================================
  // Listens for both mouseup (mouse-driven selection) and selectionchange
  // (keyboard-driven selection, e.g. Shift+Arrow) so the tooltip appears
  // however the user selects a word. On a valid single-word selection, it
  // splits the word into syllables with middle dots and shows #rwm-tooltip
  // positioned above the selection's bounding rectangle, then fetches a
  // plain-English definition.

  let tooltipEl = null;
  let lastHandledSelectionText = "";

  function getOrCreateTooltip() {
    if (tooltipEl && document.documentElement.contains(tooltipEl)) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.id = "rwm-tooltip";
    tooltipEl.className = "rwm-ui";
    tooltipEl.setAttribute("role", "dialog");
    tooltipEl.setAttribute("aria-label", "Word helper");
    document.documentElement.appendChild(tooltipEl);
    return tooltipEl;
  }

  function splitIntoSyllables(word) {
    const clean = word.toLowerCase().replace(/[^a-z]/g, "");
    if (clean.length <= 3) return [clean];

    const matches = clean.match(/[^aeiouy]*[aeiouy]+[^aeiouy]*/g);
    if (matches && matches.join("") === clean) return matches;

    // Fallback: if the vowel-group regex can't perfectly reconstruct the
    // word (rare, e.g. words with no vowels), chunk it evenly instead of
    // silently producing a broken or partial result.
    const chunks = [];
    let remaining = clean;
    while (remaining.length > 3) {
      chunks.push(remaining.slice(0, 3));
      remaining = remaining.slice(3);
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  function positionTooltipAboveRect(tooltip, rect) {
    const viewportWidth = window.innerWidth;
    const estimatedTooltipHeight = 110;
    const estimatedTooltipWidth = 250;

    let left = rect.left + rect.width / 2 - estimatedTooltipWidth / 2;
    let top = rect.top - estimatedTooltipHeight - 10;

    // If there isn't room above the selection, place the tooltip below it
    // instead of letting it run off the top of the viewport.
    if (top < 8) {
      top = rect.bottom + 10;
    }

    if (left < 8) left = 8;
    if (left + estimatedTooltipWidth > viewportWidth - 8) {
      left = viewportWidth - estimatedTooltipWidth - 8;
    }

    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function showWordTooltip(word, rect) {
    const clean = word.trim();
    if (!clean || !/^[a-zA-Z'-]{2,}$/.test(clean)) return;

    const tooltip = getOrCreateTooltip();
    const syllables = splitIntoSyllables(clean).join(" \u00b7 ");
    tooltip.innerHTML = "";

    const closeBtn = document.createElement("button");
    closeBtn.className = "rwm-tooltip-close";
    closeBtn.type = "button";
    closeBtn.textContent = "\u2715";
    closeBtn.setAttribute("aria-label", "Close word helper");
    closeBtn.addEventListener("click", hideWordTooltip);
    tooltip.appendChild(closeBtn);

    const wordEl = document.createElement("span");
    wordEl.className = "rwm-tooltip-word";
    wordEl.textContent = clean;
    tooltip.appendChild(wordEl);

    const syllableEl = document.createElement("span");
    syllableEl.className = "rwm-tooltip-syllables";
    syllableEl.textContent = syllables;
    tooltip.appendChild(syllableEl);

    const defEl = document.createElement("span");
    defEl.className = "rwm-tooltip-definition";
    defEl.textContent = "Looking up a simple definition...";
    tooltip.appendChild(defEl);

    positionTooltipAboveRect(tooltip, rect);
    tooltip.classList.add("rwm-visible");

    fetchAndRenderDefinition(clean, tooltip);
  }

  async function fetchAndRenderDefinition(word, tooltip) {
    const defEl = tooltip.querySelector(".rwm-tooltip-definition");
    if (!defEl) return;

    const existingRetry = tooltip.querySelector(".rwm-tooltip-retry-btn");
    if (existingRetry) existingRetry.remove();
    defEl.textContent = "Looking up a simple definition...";

    try {
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`);
      if (!response.ok) throw new Error("Not found");
      const data = await response.json();
      const meaning = data && data[0] && data[0].meanings && data[0].meanings[0];
      const definitionText = meaning && meaning.definitions && meaning.definitions[0] && meaning.definitions[0].definition;
      defEl.textContent = definitionText ? definitionText : "No simple definition found for this word.";
    } catch (err) {
      defEl.textContent = "Definition unavailable right now (offline, blocked, or not found).";
      const retryBtn = document.createElement("button");
      retryBtn.className = "rwm-tooltip-retry-btn";
      retryBtn.type = "button";
      retryBtn.textContent = "Try again";
      retryBtn.addEventListener("click", () => fetchAndRenderDefinition(word, tooltip));
      tooltip.appendChild(retryBtn);
    }
  }

  function hideWordTooltip() {
    if (tooltipEl) tooltipEl.classList.remove("rwm-visible");
    lastHandledSelectionText = "";
  }

  function getSelectionIfSingleWord() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (!text || !/^[a-zA-Z'-]{2,}$/.test(text)) return null;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return { text, rect };
  }

  function handleMouseUpSelection(event) {
    if (event.target.closest && event.target.closest("#rwm-copilot-drawer, #rwm-copilot-badge, #rwm-quick-toolbar, #rwm-tooltip")) return;
    const result = getSelectionIfSingleWord();
    if (result) {
      lastHandledSelectionText = result.text;
      showWordTooltip(result.text, result.rect);
    }
  }

  // selectionchange fires for keyboard-driven selection (Shift+Arrow,
  // double-click via native browser behavior, etc.) in addition to mouse
  // drags, so it is debounced and de-duplicated against the mouseup handler
  // to avoid showing the tooltip twice for the same selection.
  let selectionChangeDebounceTimer = null;

  function handleSelectionChange() {
    if (selectionChangeDebounceTimer) window.clearTimeout(selectionChangeDebounceTimer);
    selectionChangeDebounceTimer = window.setTimeout(() => {
      const result = getSelectionIfSingleWord();
      if (!result) return;
      if (result.text === lastHandledSelectionText) return;
      lastHandledSelectionText = result.text;
      showWordTooltip(result.text, result.rect);
    }, 220);
  }

  function handleDocumentPointerDown(event) {
    if (tooltipEl && tooltipEl.classList.contains("rwm-visible")) {
      if (!event.target.closest || !event.target.closest("#rwm-tooltip")) {
        hideWordTooltip();
      }
    }
  }

  document.addEventListener("mouseup", handleMouseUpSelection);
  document.addEventListener("selectionchange", handleSelectionChange);
  document.addEventListener("mousedown", handleDocumentPointerDown);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideWordTooltip();
  });

  // ======================================================================
  // FEATURE 5: In-Page AI Reading Assistant ("ReadWithMe Copilot")
  // ======================================================================
  // Injects #rwm-copilot-badge and #rwm-copilot-drawer directly into the
  // DOM, wires up click handlers for the three preset buttons plus the
  // free-text input, and answers using a real client-side extractive
  // summarizer that reads the page's own text (not a canned response).

  const STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "but", "if", "then", "than", "so", "of", "to", "in", "on",
    "at", "for", "with", "by", "from", "as", "is", "are", "was", "were", "be", "been", "being",
    "it", "its", "this", "that", "these", "those", "he", "she", "they", "we", "you", "i", "his",
    "her", "their", "our", "your", "not", "no", "do", "does", "did", "have", "has", "had", "will",
    "would", "can", "could", "should", "may", "might", "must", "about", "into", "over", "after",
    "before", "between", "out", "up", "down", "more", "most", "some", "such", "only", "also",
    "just", "there", "here", "which", "who", "whom", "what", "when", "where", "why", "how"
  ]);

  const EMPHASIS_WORDS = [
    "important", "key", "significant", "result", "means", "conclude", "overall",
    "ultimately", "shows", "found", "impact", "because", "therefore"
  ];

  function extractPageText() {
    const mainEl = document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.body;
    const clone = mainEl.cloneNode(true);
    clone.querySelectorAll(
      "script, style, noscript, nav, header, footer, aside, " +
      "#rwm-copilot-drawer, #rwm-copilot-badge, #rwm-quick-toolbar, #rwm-tooltip, [aria-hidden='true']"
    ).forEach((el) => el.remove());
    // textContent (not innerText) is used deliberately: innerText needs
    // layout information that a detached clone doesn't have and would
    // silently return an empty string.
    const text = clone.textContent || "";
    return text.replace(/\s+/g, " ").trim();
  }

  function tokenizeWords(text) {
    return text.toLowerCase().match(/[a-z0-9']+/g) || [];
  }

  function splitSentences(text) {
    const matches = text.match(/[^.!?]+[.!?]+(?:["')\]]*)?/g) || [];
    return matches.map((s) => s.trim()).filter((s) => s.split(" ").length > 4);
  }

  function buildWordFrequencies(sentences) {
    const freq = {};
    sentences.forEach((sentence) => {
      tokenizeWords(sentence).forEach((word) => {
        if (STOPWORDS.has(word) || word.length < 3) return;
        freq[word] = (freq[word] || 0) + 1;
      });
    });
    return freq;
  }

  function topSentences(pageText, count, filterFn) {
    const sentences = splitSentences(pageText);
    if (sentences.length === 0) return [];
    const freq = buildWordFrequencies(sentences);

    let scored = sentences.map((sentence, index) => {
      const words = tokenizeWords(sentence).filter((w) => !STOPWORDS.has(w) && w.length >= 3);
      const score = words.reduce((sum, w) => sum + (freq[w] || 0), 0) / Math.max(words.length, 1);
      return { sentence, index, score };
    });

    if (filterFn) {
      const filtered = scored.filter((item) => filterFn(item.sentence));
      if (filtered.length >= count) scored = filtered;
    }

    scored.sort((a, b) => b.score - a.score);
    const chosen = scored.slice(0, count).sort((a, b) => a.index - b.index);
    return chosen.map((item) => item.sentence);
  }

  function summarizeBullets(pageText) {
    const sentences = topSentences(pageText, 3);
    if (sentences.length === 0) return "I couldn't find enough readable text on this page to summarize.";
    return "Here's a quick summary:\n\n" + sentences.map((s) => `\u2022 ${s}`).join("\n");
  }

  function simplifySentence(sentence) {
    let s = sentence.replace(/\([^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
    const words = s.split(" ");
    if (words.length > 24) {
      const commaIndex = s.indexOf(",");
      if (commaIndex > 20 && commaIndex < s.length - 10) {
        s = `${s.slice(0, commaIndex)}.`;
      }
    }
    return s;
  }

  function explainSimply(pageText) {
    const sentences = topSentences(pageText, 2);
    if (sentences.length === 0) return "I couldn't find enough readable text on this page to explain.";
    const simplified = sentences.map(simplifySentence);
    return "In simple terms:\n\n" + simplified.map((s) => `\u2022 ${s}`).join("\n");
  }

  function mainTakeaways(pageText) {
    const sentences = topSentences(
      pageText,
      3,
      (s) => EMPHASIS_WORDS.some((w) => s.toLowerCase().includes(w)) || /\d/.test(s)
    );
    if (sentences.length === 0) {
      return "I couldn't identify clear takeaways on this page -- try 'Summarize page in 3 bullets' instead.";
    }
    return "Key takeaways:\n\n" + sentences.map((s) => `\u2192 ${s}`).join("\n");
  }

  function answerCustomQuestion(promptText, pageText) {
    const sentences = splitSentences(pageText);
    if (sentences.length === 0) return "I couldn't find readable text on this page to answer that.";

    const questionWords = tokenizeWords(promptText).filter((w) => !STOPWORDS.has(w) && w.length >= 3);
    if (questionWords.length === 0) {
      return "Could you rephrase your question with a bit more detail?";
    }

    const scored = sentences.map((sentence, index) => {
      const words = tokenizeWords(sentence);
      const overlap = questionWords.filter((w) => words.includes(w)).length;
      return { sentence, index, overlap };
    }).filter((item) => item.overlap > 0);

    if (scored.length === 0) {
      return "I couldn't find a specific answer to that on this page. Try asking about the page's main topic instead.";
    }

    scored.sort((a, b) => b.overlap - a.overlap || a.index - b.index);
    const top = scored.slice(0, 2).sort((a, b) => a.index - b.index);
    return "Based on this page:\n\n" + top.map((item) => `\u2022 ${item.sentence}`).join("\n");
  }

  function getAssistantReply(promptText) {
    const pageText = extractPageText();
    const lower = promptText.toLowerCase();
    if (lower.includes("summarize") && lower.includes("bullet")) return summarizeBullets(pageText);
    if (lower.includes("explain") && lower.includes("simpl")) return explainSimply(pageText);
    if (lower.includes("takeaway")) return mainTakeaways(pageText);
    return answerCustomQuestion(promptText, pageText);
  }

  // ---- Copilot badge + drawer: direct DOM injection ----------------------

  let copilotUIBuilt = false;

  function buildCopilotUI() {
    if (copilotUIBuilt) return;
    copilotUIBuilt = true;

    const badge = document.createElement("button");
    badge.id = "rwm-copilot-badge";
    badge.className = "rwm-ui";
    badge.type = "button";
    badge.setAttribute("aria-label", "Open ReadWithMe reading copilot");
    badge.textContent = "\uD83D\uDCAC";
    document.documentElement.appendChild(badge);

    const drawer = document.createElement("div");
    drawer.id = "rwm-copilot-drawer";
    drawer.className = "rwm-ui";
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-label", "ReadWithMe reading copilot");

    drawer.innerHTML = `
      <div class="rwm-copilot-header">
        <span>ReadWithMe Copilot</span>
        <button type="button" class="rwm-copilot-close" aria-label="Close copilot">&times;</button>
      </div>
      <div class="rwm-copilot-presets">
        <button type="button" class="rwm-copilot-preset-btn" data-preset-text="Summarize page in 3 bullets">\uD83D\uDCA1 Summarize page in 3 bullets</button>
        <button type="button" class="rwm-copilot-preset-btn" data-preset-text="Explain this page simply">\uD83E\uDDE0 Explain this page simply</button>
        <button type="button" class="rwm-copilot-preset-btn" data-preset-text="Key takeaways">\uD83D\uDD11 Key takeaways</button>
      </div>
      <div class="rwm-copilot-messages" id="rwm-copilot-messages"></div>
      <div class="rwm-copilot-input-row">
        <input type="text" class="rwm-copilot-input" id="rwm-copilot-input" placeholder="Ask about this page..." aria-label="Ask about this page" />
        <button type="button" class="rwm-copilot-send-btn" id="rwm-copilot-send-btn" aria-label="Send question">&#9658;</button>
      </div>
    `;
    document.documentElement.appendChild(drawer);

    badge.addEventListener("click", () => toggleCopilotDrawer(true));
    drawer.querySelector(".rwm-copilot-close").addEventListener("click", () => toggleCopilotDrawer(false));

    // Click handlers for each of the three preset buttons.
    drawer.querySelectorAll(".rwm-copilot-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => handleUserCopilotMessage(btn.dataset.presetText));
    });

    const input = drawer.querySelector("#rwm-copilot-input");
    const sendBtn = drawer.querySelector("#rwm-copilot-send-btn");

    sendBtn.addEventListener("click", () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      handleUserCopilotMessage(text);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendBtn.click();
      }
    });

    renderCopilotWelcomeMessage();
  }

  function renderCopilotWelcomeMessage() {
    appendCopilotMessage(
      "assistant",
      "Hi! I can summarize this page, explain it simply, or answer a question about what's on it. Try one of the buttons above, or type your own question."
    );
  }

  function toggleCopilotDrawer(forceOpen) {
    const drawer = document.getElementById("rwm-copilot-drawer");
    if (!drawer) return;
    const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !drawer.classList.contains("rwm-open");
    drawer.classList.toggle("rwm-open", shouldOpen);
    if (shouldOpen) {
      const input = document.getElementById("rwm-copilot-input");
      if (input) input.focus();
    }
  }

  function appendCopilotMessage(role, text) {
    const container = document.getElementById("rwm-copilot-messages");
    if (!container) return null;
    const msgEl = document.createElement("div");
    msgEl.className = `rwm-copilot-msg rwm-copilot-msg-${role}`;
    msgEl.textContent = text;
    container.appendChild(msgEl);
    container.scrollTop = container.scrollHeight;
    return msgEl;
  }

  function handleUserCopilotMessage(text) {
    appendCopilotMessage("user", text);
    // The response engine runs entirely client-side and synchronously, but
    // a short setTimeout keeps the "thinking" state visible for a beat so
    // the exchange reads naturally rather than flashing instantly.
    const thinkingEl = appendCopilotMessage("assistant", "Thinking...");
    window.setTimeout(() => {
      try {
        const reply = getAssistantReply(text);
        if (thinkingEl) thinkingEl.textContent = reply;
      } catch (err) {
        if (thinkingEl) thinkingEl.textContent = "Sorry, something went wrong while reading this page. Please try again.";
      }
      const container = document.getElementById("rwm-copilot-messages");
      if (container) container.scrollTop = container.scrollHeight;
    }, 300);
  }

  // ======================================================================
  // FEATURE 9: Read Aloud (Cursor Text-to-Speech)
  // ======================================================================
  // When enabled, hovering the mouse cursor over readable text elements
  // triggers Chrome's native Web Speech API to read the line/sentence
  // under the cursor aloud. Moving the mouse to a new line immediately
  // cancels any in-progress speech so audio never overlaps or lags.
  // The currently spoken element gets a soft highlight tint.
  //
  // PERFORMANCE: The mousemove listener is passive and debounced at
  // 350ms so it fires at most ~3 times/second, preventing layout
  // thrashing from elementFromPoint/getComputedStyle. The debounce
  // stores the latest coordinates and only resolves text + speaks after
  // the cursor has settled. speechSynthesis.cancel() is called
  // immediately (before the debounce) on every movement so old speech
  // never overlaps. A lastSpokenText guard prevents re-reading the
  // same text when the mouse slightly wiggles over the same block.

  let readAloudEnabled = false;
  let readAloudDebounceTimer = null;
  let readAloudLastElement = null;
  let readAloudLastSpokenText = "";
  let readAloudHighlightEl = null;
  let readAloudMouseMoveHandler = null;
  let readAloudTapHandler = null;
  // Stashed coordinates updated on every move; only consumed by the
  // debounced handler so elementFromPoint is called at most once per
  // 350ms window instead of on every mousemove event.
  let readAloudPendingX = 0;
  let readAloudPendingY = 0;

  // Extract the sentence/line of text nearest to the cursor position.
  function getTextAtCursor(clientX, clientY) {
    // Try caretRangeFromPoint (Chrome/Edge) first for precise line extraction.
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(clientX, clientY);
      if (range && range.startContainer && range.startContainer.nodeType === 3) {
        const textNode = range.startContainer;
        const fullText = textNode.textContent || "";
        const offset = range.startOffset;

        // Find the sentence boundaries around the cursor offset.
        let start = offset;
        let end = offset;

        // Walk backward to find sentence start (period, newline, or text start).
        while (start > 0 && !/[.!?\n]/.test(fullText[start - 1])) start--;

        // Walk forward to find sentence end.
        while (end < fullText.length && !/[.!?\n]/.test(fullText[end])) end++;
        // Include the punctuation.
        if (end < fullText.length && /[.!?]/.test(fullText[end])) end++;

        const sentence = fullText.slice(start, end).trim();
        if (sentence.length > 2) {
          return { text: sentence, element: textNode.parentElement };
        }
      }
    }

    // Fallback: use elementFromPoint to get the nearest readable element.
    const el = document.elementFromPoint(clientX, clientY);
    if (el && READABLE_TAGS.has(el.tagName) && !el.closest(".rwm-ui")) {
      const text = (el.textContent || "").trim();
      if (text.length > 2 && text.length < 2000) {
        return { text, element: el };
      }
    }

    return null;
  }

  function highlightReadAloudElement(el) {
    clearReadAloudHighlight();
    if (!el) return;
    el.classList.add("rwm-read-aloud-highlight");
    readAloudHighlightEl = el;
  }

  function clearReadAloudHighlight() {
    if (readAloudHighlightEl) {
      readAloudHighlightEl.classList.remove("rwm-read-aloud-highlight");
      readAloudHighlightEl = null;
    }
  }

  function speakText(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = currentSettings.readAloudSpeed || 1.0;

    // Try to set the selected voice.
    if (currentSettings.readAloudVoice) {
      const voices = window.speechSynthesis.getVoices();
      const selected = voices.find((v) => v.name === currentSettings.readAloudVoice);
      if (selected) utterance.voice = selected;
    }

    utterance.onend = () => {
      clearReadAloudHighlight();
    };

    window.speechSynthesis.speak(utterance);
  }

  function handleReadAloudMouseMove(event) {
    // 1. Cancel old speech immediately on ANY cursor movement so audio
    //    never overlaps or lags behind when the user moves to a new line.
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    clearReadAloudHighlight();

    // 2. Stash the latest coordinates (cheap, no DOM access).
    readAloudPendingX = event.clientX;
    readAloudPendingY = event.clientY;

    // 3. Debounce: restart a 350ms timer. The heavy work (elementFromPoint,
    //    caretRangeFromPoint, speech) only happens once the cursor settles.
    if (readAloudDebounceTimer) {
      window.clearTimeout(readAloudDebounceTimer);
    }

    readAloudDebounceTimer = window.setTimeout(() => {
      readAloudDebounceTimer = null;

      const clientX = readAloudPendingX;
      const clientY = readAloudPendingY;

      // Skip if cursor is over extension UI.
      const target = document.elementFromPoint(clientX, clientY);
      if (target && target.closest && target.closest(".rwm-ui")) return;

      // Identify the readable parent element under the cursor.
      const readableParent = target && target.closest
        ? target.closest("p, span, article, li, h1, h2, h3, h4, h5, h6")
        : null;

      readAloudLastElement = readableParent;

      const result = getTextAtCursor(clientX, clientY);
      if (result && result.text) {
        // Guard: don't re-read the same text if the mouse slightly
        // wiggles within the same block.
        if (result.text === readAloudLastSpokenText) return;

        readAloudLastSpokenText = result.text;
        highlightReadAloudElement(result.element);
        speakText(result.text);
      }
    }, 350);
  }

  // Tap-to-Read for touchscreens: since mobile devices don't have a
  // persistent hover state, a single tap on a readable text block
  // (p, article, li, h1-h6) triggers TTS. The handler uses the touch
  // coordinates to extract the nearest sentence, highlights it, and
  // speaks it. It respects the same duplicate-text guard as the
  // desktop mousemove handler.
  function handleReadAloudTap(event) {
    if (!event.changedTouches || event.changedTouches.length === 0) return;

    const touch = event.changedTouches[0];
    const clientX = touch.clientX;
    const clientY = touch.clientY;

    // Skip taps on the extension's own UI.
    const target = document.elementFromPoint(clientX, clientY);
    if (target && target.closest && target.closest(".rwm-ui")) return;

    // Only trigger on readable text tags.
    const readableParent = target && target.closest
      ? target.closest("p, article, li, h1, h2, h3, h4, h5, h6")
      : null;
    if (!readableParent) return;

    // Cancel any in-progress speech first.
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    clearReadAloudHighlight();

    const result = getTextAtCursor(clientX, clientY);
    if (result && result.text) {
      // Don't re-read the exact same text on accidental double-taps.
      if (result.text === readAloudLastSpokenText) return;

      readAloudLastSpokenText = result.text;
      readAloudLastElement = readableParent;
      highlightReadAloudElement(result.element);
      speakText(result.text);
    }
  }

  function enableReadAloud() {
    if (readAloudEnabled) return;
    readAloudEnabled = true;

    readAloudMouseMoveHandler = handleReadAloudMouseMove;
    document.addEventListener("mousemove", readAloudMouseMoveHandler, { passive: true });

    // Tap-to-Read for touchscreens.
    readAloudTapHandler = handleReadAloudTap;
    document.addEventListener("touchend", readAloudTapHandler, { passive: true });
  }

  function disableReadAloud() {
    readAloudEnabled = false;
    if (readAloudMouseMoveHandler) {
      document.removeEventListener("mousemove", readAloudMouseMoveHandler);
      readAloudMouseMoveHandler = null;
    }
    if (readAloudTapHandler) {
      document.removeEventListener("touchend", readAloudTapHandler);
      readAloudTapHandler = null;
    }
    if (readAloudDebounceTimer) {
      window.clearTimeout(readAloudDebounceTimer);
      readAloudDebounceTimer = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    clearReadAloudHighlight();
    readAloudLastElement = null;
    readAloudLastSpokenText = "";
  }

  // ======================================================================
  // FEATURE 6: Quick On-Screen Toggle Toolbar
  // ======================================================================
  // A floating toolbar placed immediately left of #rwm-copilot-badge with
  // toggle buttons: Focus Window, Calm Mode, Dark Mode, and Read Aloud.
  // Clicking one flips the setting, applies it to the page immediately,
  // updates the button's active look (fill + check mark + aria-pressed),
  // and writes only that one key to chrome.storage.sync. The popup listens
  // to storage changes, so its switches stay in sync, and so do the content
  // scripts in the user's other tabs.

  let quickToolbarBuilt = false;
  let quickFocusBtn = null;
  let quickCalmBtn = null;
  let quickThemeBtn = null;
  let quickReadAloudBtn = null;

  function createQuickButton(emoji, label, settingKey) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rwm-quick-btn";
    btn.textContent = emoji;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", "false");
    btn.title = label;
    btn.dataset.settingKey = settingKey;
    btn.addEventListener("click", () => toggleSettingFromToolbar(settingKey));
    return btn;
  }

  function buildQuickToolbar() {
    if (quickToolbarBuilt && document.documentElement.contains(document.getElementById("rwm-quick-toolbar"))) return;
    quickToolbarBuilt = true;

    const toolbar = document.createElement("div");
    toolbar.id = "rwm-quick-toolbar";
    toolbar.className = "rwm-ui";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "ReadWithMe quick controls");

    quickFocusBtn = createQuickButton("\uD83D\uDC41\uFE0F", "Focus Window", "focusWindow");
    quickCalmBtn = createQuickButton("\uD83E\uDDD8", "Calm Mode", "calmMode");
    quickThemeBtn = createQuickButton("\uD83C\uDF19", "Dark Mode", "theme");
    quickReadAloudBtn = createQuickButton("\uD83D\uDD0A", "Read Aloud", "readAloud");

    toolbar.appendChild(quickFocusBtn);
    toolbar.appendChild(quickCalmBtn);
    toolbar.appendChild(quickThemeBtn);
    toolbar.appendChild(quickReadAloudBtn);
    document.documentElement.appendChild(toolbar);
  }

  function setQuickButtonState(btn, baseLabel, isOn) {
    if (!btn) return;
    btn.classList.toggle("rwm-on", !!isOn);
    btn.setAttribute("aria-pressed", isOn ? "true" : "false");
    const label = `${baseLabel}: ${isOn ? "on" : "off"} (click to turn ${isOn ? "off" : "on"})`;
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }

  function updateQuickToolbarState() {
    setQuickButtonState(quickFocusBtn, "Focus Window", currentSettings.focusWindow);
    setQuickButtonState(quickCalmBtn, "Calm Mode", currentSettings.calmMode);
    setQuickButtonState(quickThemeBtn, "Dark Mode", currentSettings.theme === "dark");
    setQuickButtonState(quickReadAloudBtn, "Read Aloud", currentSettings.readAloud);
  }

  function toggleSettingFromToolbar(settingKey) {
    // "theme" is stored as 'light' | 'dark'; every other toggle is a boolean.
    const nextValue = settingKey === "theme"
      ? (currentSettings.theme === "dark" ? "light" : "dark")
      : !currentSettings[settingKey];
    // Apply immediately so the page and the button react with no delay...
    applySettings({ ...currentSettings, [settingKey]: nextValue });
    // ...then persist just this key so nothing else the popup set is touched.
    // The popup's chrome.storage.onChanged listener picks this up.
    try {
      chrome.storage.sync.set({ [settingKey]: nextValue });
    } catch (err) {
      // Extension context can be invalidated after an update/reload; the
      // on-page change has already been applied, so fail quietly.
    }
  }

  // ======================================================================
  // Orchestration
  // ======================================================================

  // Stamps the active theme on <html>; content.css restyles every
  // .rwm-ui widget (toolbar, copilot, tooltip) from that attribute.
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-rwm-theme", theme === "dark" ? "dark" : "light");
  }

  function applySettings(incomingSettings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...incomingSettings };
    currentSettings.theme = currentSettings.theme === "dark" ? "dark" : "light";

    // Measure the page's native darkness before any extension styling exists.
    isOriginalPageDark();

    applyTheme(currentSettings.theme);

    applyTypographyAndTint(currentSettings);
    applyPageTheme(getPageMode(currentSettings));

    if (currentSettings.focusWindow) {
      enableFocusWindow();
    } else {
      disableFocusWindow();
    }

    if (currentSettings.calmMode) {
      enableCalmMode();
    } else {
      disableCalmMode();
    }

    // Read Aloud
    if (currentSettings.readAloud) {
      enableReadAloud();
    } else {
      disableReadAloud();
    }

    buildCopilotUI();
    buildQuickToolbar();
    updateQuickToolbarState();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "RWM_UPDATE_SETTINGS") {
      applySettings(message.settings);
      sendResponse({ status: "ok" });
    }
    return true;
  });

  // Keeps every tab (and the popup, which has its own listener) in sync
  // whenever any stored setting changes, whether it came from the popup,
  // another tab's quick toolbar, or the Reset button.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    const updated = { ...currentSettings };
    let touched = false;
    Object.keys(DEFAULT_SETTINGS).forEach((key) => {
      if (changes[key]) {
        updated[key] = changes[key].newValue !== undefined ? changes[key].newValue : DEFAULT_SETTINGS[key];
        touched = true;
      }
    });
    if (touched) applySettings(updated);
  });

  // ------------------------------------------------------------------
  // Deferred initialization
  // ------------------------------------------------------------------
  // Heavy DOM work (getComputedStyle scans for page-theme detection,
  // Calm Mode element scanning, typography injection) is deferred until
  // the page has finished loading AND the browser's main thread is idle.
  // This ensures the target website renders instantly without being
  // blocked by the extension's startup work.
  //
  // Flow:
  //   1. Wait for document.readyState === "complete" (page fully loaded)
  //   2. Then schedule applySettings via requestIdleCallback so the
  //      browser finishes any remaining paint/layout work first
  //   3. Lightweight listeners (message, storage) are attached eagerly
  //      so settings changes from the popup are never missed
  //
  // requestIdleCallback shim for environments that don't support it
  // (very rare in modern Chrome, but safe to have).

  const scheduleIdle = typeof window.requestIdleCallback === "function"
    ? (fn) => window.requestIdleCallback(fn, { timeout: 2000 })
    : (fn) => window.setTimeout(fn, 1);

  function initHeavy(stored) {
    applySettings(stored);
  }

  function init() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
      // If the page is already complete, go straight to idle scheduling.
      // Otherwise wait for the "complete" state so the page finishes its
      // own rendering before we touch the DOM with expensive scans.
      if (document.readyState === "complete") {
        scheduleIdle(() => initHeavy(stored));
      } else {
        window.addEventListener("load", () => {
          scheduleIdle(() => initHeavy(stored));
        }, { once: true });
      }
    });
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
