// ReadWithMe - popup.js
// Reads/writes chrome.storage.sync so settings persist across tabs and
// devices, and live-messages the active tab's content script on every change.

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

// Cached references to DOM controls, populated on DOMContentLoaded.
let els = {};

document.addEventListener("DOMContentLoaded", () => {
  els = {
    fontSelect: document.getElementById("fontSelect"),
    fontSizeRange: document.getElementById("fontSizeRange"),
    fontSizeValue: document.getElementById("fontSizeValue"),
    lineHeightRange: document.getElementById("lineHeightRange"),
    lineHeightValue: document.getElementById("lineHeightValue"),
    letterSpacingRange: document.getElementById("letterSpacingRange"),
    letterSpacingValue: document.getElementById("letterSpacingValue"),
    swatches: Array.from(document.querySelectorAll(".rwm-swatch")),
    focusWindowToggle: document.getElementById("focusWindowToggle"),
    calmModeToggle: document.getElementById("calmModeToggle"),
    themeToggle: document.getElementById("themeToggle"),
    themePagesToggle: document.getElementById("themePagesToggle"),
    readAloudToggle: document.getElementById("readAloudToggle"),
    voiceSelect: document.getElementById("voiceSelect"),
    speedRange: document.getElementById("speedRange"),
    speedValue: document.getElementById("speedValue"),
    closeTabsBtn: document.getElementById("closeTabsBtn"),
    closeTabsConfirm: document.getElementById("closeTabsConfirm"),
    closeTabsMessage: document.getElementById("closeTabsMessage"),
    closeTabsYes: document.getElementById("closeTabsYes"),
    closeTabsNo: document.getElementById("closeTabsNo"),
    tabsStatus: document.getElementById("tabsStatus"),
    resetBtn: document.getElementById("resetBtn")
  };

  populateVoices();
  loadAndApplyStoredSettings();
  attachEventListeners();

  // The on-page quick toolbar (and other tabs) write to chrome.storage.sync
  // directly. Listening here keeps these switches in sync if the popup is
  // open while that happens.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
      updateControlsFromSettings(stored);
    });
  });
});

// ---------------------------------------------------------------------------
// Voice dropdown population
// ---------------------------------------------------------------------------
// speechSynthesis.getVoices() may return an empty array on first call;
// the voiceschanged event fires when voices are loaded asynchronously.

function populateVoices() {
  if (!window.speechSynthesis) return;

  function fillVoiceList() {
    const voices = window.speechSynthesis.getVoices();
    if (!els.voiceSelect) return;

    // Preserve current selection if possible.
    const currentVal = els.voiceSelect.value;
    els.voiceSelect.innerHTML = '<option value="">System Default</option>';

    voices.forEach((voice) => {
      const opt = document.createElement("option");
      opt.value = voice.name;
      opt.textContent = `${voice.name} (${voice.lang})`;
      if (voice.default) opt.textContent += " — default";
      els.voiceSelect.appendChild(opt);
    });

    // Restore selection.
    if (currentVal) {
      els.voiceSelect.value = currentVal;
    }
  }

  fillVoiceList();
  window.speechSynthesis.addEventListener("voiceschanged", fillVoiceList);
}

function loadAndApplyStoredSettings() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    updateControlsFromSettings(stored);
  });
}

function updateControlsFromSettings(settings) {
  els.fontSelect.value = settings.font;

  els.fontSizeRange.value = settings.fontSize;
  els.fontSizeValue.textContent = `${settings.fontSize}px`;
  els.fontSizeRange.setAttribute("aria-valuetext", `${settings.fontSize} pixels`);

  els.lineHeightRange.value = settings.lineHeight;
  els.lineHeightValue.textContent = settings.lineHeight.toFixed(1);
  els.lineHeightRange.setAttribute("aria-valuetext", settings.lineHeight.toFixed(1));

  els.letterSpacingRange.value = settings.letterSpacing;
  els.letterSpacingValue.textContent = `${settings.letterSpacing.toFixed(2)}em`;
  els.letterSpacingRange.setAttribute("aria-valuetext", `${settings.letterSpacing.toFixed(2)} em`);

  els.swatches.forEach((swatch) => {
    const isActive = swatch.dataset.tint === settings.bgTint;
    swatch.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  els.focusWindowToggle.checked = !!settings.focusWindow;
  els.calmModeToggle.checked = !!settings.calmMode;

  els.themeToggle.checked = settings.theme === "dark";
  els.themePagesToggle.checked = settings.themePages !== false;

  // Read Aloud controls
  els.readAloudToggle.checked = !!settings.readAloud;
  if (settings.readAloudVoice && els.voiceSelect) {
    els.voiceSelect.value = settings.readAloudVoice;
  }
  if (els.speedRange) {
    els.speedRange.value = settings.readAloudSpeed || 1.0;
    els.speedValue.textContent = `${parseFloat(els.speedRange.value).toFixed(1)}x`;
    els.speedRange.setAttribute("aria-valuetext", `${parseFloat(els.speedRange.value).toFixed(1)}x`);
  }

  applyPopupTheme(settings.theme);
}

// Stamps the theme on <html>; popup.html's CSS variables do the rest.
function applyPopupTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
}

function readSettingsFromControls() {
  const activeSwatch = els.swatches.find((s) => s.getAttribute("aria-pressed") === "true");
  return {
    font: els.fontSelect.value,
    fontSize: parseInt(els.fontSizeRange.value, 10),
    lineHeight: parseFloat(els.lineHeightRange.value),
    letterSpacing: parseFloat(els.letterSpacingRange.value),
    bgTint: activeSwatch ? activeSwatch.dataset.tint : "none",
    focusWindow: els.focusWindowToggle.checked,
    calmMode: els.calmModeToggle.checked,
    theme: els.themeToggle.checked ? "dark" : "light",
    themePages: els.themePagesToggle.checked,
    readAloud: els.readAloudToggle.checked,
    readAloudVoice: els.voiceSelect ? els.voiceSelect.value : "",
    readAloudSpeed: els.speedRange ? parseFloat(els.speedRange.value) : 1.0
  };
}

function persistAndBroadcast() {
  const settings = readSettingsFromControls();
  chrome.storage.sync.set(settings, () => {
    sendSettingsToActiveTab(settings);
  });
}

function sendSettingsToActiveTab(settings) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0] || typeof tabs[0].id !== "number") return;
    chrome.tabs.sendMessage(
      tabs[0].id,
      { type: "RWM_UPDATE_SETTINGS", settings },
      () => {
        // Swallow "Receiving end does not exist" errors on pages where the
        // content script cannot run (e.g. chrome:// pages, the Web Store).
        if (chrome.runtime.lastError) {
          // No-op: intentionally ignored.
        }
      }
    );
  });
}

function attachEventListeners() {
  els.fontSelect.addEventListener("change", persistAndBroadcast);

  els.fontSizeRange.addEventListener("input", () => {
    els.fontSizeValue.textContent = `${els.fontSizeRange.value}px`;
    els.fontSizeRange.setAttribute("aria-valuetext", `${els.fontSizeRange.value} pixels`);
  });
  els.fontSizeRange.addEventListener("change", persistAndBroadcast);

  els.lineHeightRange.addEventListener("input", () => {
    const val = parseFloat(els.lineHeightRange.value).toFixed(1);
    els.lineHeightValue.textContent = val;
    els.lineHeightRange.setAttribute("aria-valuetext", val);
  });
  els.lineHeightRange.addEventListener("change", persistAndBroadcast);

  els.letterSpacingRange.addEventListener("input", () => {
    const val = parseFloat(els.letterSpacingRange.value).toFixed(2);
    els.letterSpacingValue.textContent = `${val}em`;
    els.letterSpacingRange.setAttribute("aria-valuetext", `${val} em`);
  });
  els.letterSpacingRange.addEventListener("change", persistAndBroadcast);

  els.swatches.forEach((swatch) => {
    swatch.addEventListener("click", () => {
      els.swatches.forEach((s) => s.setAttribute("aria-pressed", "false"));
      swatch.setAttribute("aria-pressed", "true");
      persistAndBroadcast();
    });
  });

  els.focusWindowToggle.addEventListener("change", persistAndBroadcast);
  els.calmModeToggle.addEventListener("change", persistAndBroadcast);
  els.themePagesToggle.addEventListener("change", persistAndBroadcast);
  els.themeToggle.addEventListener("change", () => {
    applyPopupTheme(els.themeToggle.checked ? "dark" : "light");
    persistAndBroadcast();
  });

  // Read Aloud controls
  els.readAloudToggle.addEventListener("change", persistAndBroadcast);
  if (els.voiceSelect) {
    els.voiceSelect.addEventListener("change", persistAndBroadcast);
  }
  if (els.speedRange) {
    els.speedRange.addEventListener("input", () => {
      const val = parseFloat(els.speedRange.value).toFixed(1);
      els.speedValue.textContent = `${val}x`;
      els.speedRange.setAttribute("aria-valuetext", `${val}x`);
    });
    els.speedRange.addEventListener("change", persistAndBroadcast);
  }

  els.resetBtn.addEventListener("click", () => {
    // Reset restores reading settings but keeps the chosen theme choices.
    const resetSettings = {
      ...DEFAULT_SETTINGS,
      theme: els.themeToggle.checked ? "dark" : "light",
      themePages: els.themePagesToggle.checked
    };
    chrome.storage.sync.set(resetSettings, () => {
      updateControlsFromSettings(resetSettings);
      sendSettingsToActiveTab(resetSettings);
    });
  });
}

// ---------------------------------------------------------------------------
// Close all other tabs (current window)
// ---------------------------------------------------------------------------
// Two-step on purpose: the first click shows how many tabs would be closed,
// and nothing closes until the user confirms. The active tab and pinned tabs
// are always kept. Closed tabs can be reopened with Ctrl/Cmd+Shift+T.
// chrome.tabs.query/remove need no extra permission for this (only tab ids
// are used, never URLs or titles).

let tabsPendingClose = [];

function setTabsStatus(text) {
  els.tabsStatus.textContent = text;
}

function hideCloseTabsConfirm() {
  els.closeTabsConfirm.hidden = true;
  els.closeTabsBtn.hidden = false;
  tabsPendingClose = [];
}

function startCloseOtherTabs() {
  setTabsStatus("");
  chrome.tabs.query({ currentWindow: true }, (tabs) => {
    const others = (tabs || []).filter((t) => !t.active && !t.pinned && typeof t.id === "number");
    if (others.length === 0) {
      setTabsStatus("No other tabs to close.");
      return;
    }
    tabsPendingClose = others.map((t) => t.id);
    els.closeTabsMessage.textContent =
      `Close ${others.length} other tab${others.length === 1 ? "" : "s"} in this window? ` +
      "Pinned tabs stay open. Unsaved work in those tabs may be lost.";
    els.closeTabsBtn.hidden = true;
    els.closeTabsConfirm.hidden = false;
    els.closeTabsNo.focus();
  });
}

function confirmCloseOtherTabs() {
  const ids = tabsPendingClose.slice();
  hideCloseTabsConfirm();
  if (ids.length === 0) return;
  chrome.tabs.remove(ids, () => {
    if (chrome.runtime.lastError) {
      setTabsStatus("Some tabs could not be closed.");
    } else {
      setTabsStatus(`Closed ${ids.length} tab${ids.length === 1 ? "" : "s"}. Press Ctrl/Cmd+Shift+T to reopen.`);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  els.closeTabsBtn.addEventListener("click", startCloseOtherTabs);
  els.closeTabsYes.addEventListener("click", confirmCloseOtherTabs);
  els.closeTabsNo.addEventListener("click", () => {
    hideCloseTabsConfirm();
    setTabsStatus("Cancelled. No tabs were closed.");
  });
});
