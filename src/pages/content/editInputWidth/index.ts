/**
 * Adjusts the composer (input box) width on claude.ai.
 *
 * Settings key: `claudeEditInputWidth` (viewport %, stored 30..100).
 *
 * Claude has two composer layouts (both verified by browser-harness):
 *   - INSIDE A CONVERSATION:  composer lives inside a sticky-bottom div
 *       `div.sticky.bottom-0.mx-auto.w-full.pt-6`, itself a child of the
 *       outer chat column `div.max-w-3xl.md\:px-2`.  The chatWidth
 *       adjuster lifts the outer max-w-3xl cap, so we just set the
 *       sticky-bottom wrapper to the user's input width.
 *   - NEW CHAT / HOME PAGE:  composer lives inside a centered card
 *       `div.top-5.z-10.mx-auto.w-full.max-w-2xl` directly under <main>.
 *       We override that max-w-2xl so the user's setting also applies
 *       on the new-chat screen.
 *
 * The setting is intentionally INDEPENDENT from chatWidth — many users
 * want a narrow input but wide message column (or the reverse).
 */

const STYLE_ID = 'cv-edit-input-width';
const DEFAULT_PERCENT = 60;
const MIN_PERCENT = 30;
const MAX_PERCENT = 100;
const LEGACY_BASELINE_PX = 1200;

const VALUE_KEY = 'claudeEditInputWidth';
const ENABLED_KEY = 'cvEditInputWidthEnabled';

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const normalizePercent = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  if (value > MAX_PERCENT) {
    const approx = (value / LEGACY_BASELINE_PX) * 100;
    return clampPercent(approx, MIN_PERCENT, MAX_PERCENT);
  }
  return clampPercent(value, MIN_PERCENT, MAX_PERCENT);
};

function applyWidth(widthPercent: number): void {
  const normalized = normalizePercent(widthPercent, DEFAULT_PERCENT);
  const widthValue = `${normalized}vw`;

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }

  style.textContent = `
    /*
     * Sticky-bottom composer wrapper inside a conversation.
     * Its parent (the outer max-w-3xl) is uncapped by chatWidth so this
     * width sets the composer's actual visual width.
     */
    div.sticky.bottom-0.mx-auto.w-full.pt-6 {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    /*
     * New-chat composer card (homepage).  Tailwind escapes \: in the
     * generated class name so md:px-2 becomes .md\:px-2.
     */
    main > div.top-5.z-10.mx-auto.w-full.max-w-2xl,
    main div.top-5.z-10.mx-auto.w-full.max-w-2xl,
    div.top-5.z-10.mx-auto.w-full.max-w-2xl {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    /*
     * Structural fallback for either layout — any div that directly
     * contains the fieldset that wraps the ProseMirror editor.
     */
    @supports selector(:has(*)) {
      div.mx-auto:has(> fieldset),
      div.mx-auto.w-full:has(fieldset > div > div > .ProseMirror) {
        max-width: ${widthValue} !important;
        width: min(100%, ${widthValue}) !important;
      }
    }
  `;
}

function removeStyles(): void {
  const style = document.getElementById(STYLE_ID);
  if (style) {
    style.remove();
  }
}

export function startEditInputWidthAdjuster(): void {
  let currentWidthPercent = DEFAULT_PERCENT;
  let enabled = false;

  chrome.storage?.sync?.get([VALUE_KEY, ENABLED_KEY], (res) => {
    const storedWidth = res?.[VALUE_KEY];
    const normalized = normalizePercent(
      typeof storedWidth === 'number' ? storedWidth : DEFAULT_PERCENT,
      DEFAULT_PERCENT,
    );
    currentWidthPercent = normalized;

    const enabledRaw = res?.[ENABLED_KEY];
    if (enabledRaw === undefined) {
      enabled =
        typeof storedWidth === 'number' &&
        normalizePercent(storedWidth, DEFAULT_PERCENT) !== DEFAULT_PERCENT;
      if (enabled) {
        try {
          chrome.storage?.sync?.set({ [ENABLED_KEY]: true });
        } catch {}
      }
    } else {
      enabled = enabledRaw === true;
    }

    if (enabled) {
      applyWidth(currentWidthPercent);
    }

    if (typeof storedWidth === 'number' && storedWidth !== normalized) {
      try {
        chrome.storage?.sync?.set({ [VALUE_KEY]: normalized });
      } catch (e) {
        console.warn('[Claude-Voyager] Failed to migrate input width:', e);
      }
    }
  });

  const storageChangeHandler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'sync') return;

    if (changes[ENABLED_KEY]) {
      enabled = changes[ENABLED_KEY].newValue === true;
      if (enabled) {
        applyWidth(currentWidthPercent);
      } else {
        removeStyles();
      }
    }

    if (changes[VALUE_KEY]) {
      const newWidth = changes[VALUE_KEY].newValue;
      if (typeof newWidth === 'number') {
        const normalized = normalizePercent(newWidth, DEFAULT_PERCENT);
        currentWidthPercent = normalized;
        if (enabled) {
          applyWidth(currentWidthPercent);
        }

        if (normalized !== newWidth) {
          try {
            chrome.storage?.sync?.set({ [VALUE_KEY]: normalized });
          } catch (e) {
            console.warn('[Claude-Voyager] Failed to normalize input width:', e);
          }
        }
      }
    }
  };

  chrome.storage?.onChanged?.addListener(storageChangeHandler);

  // Re-apply on DOM changes (new conversation, edit-mode toggling, etc.).
  let debounceTimer: number | null = null;
  const observer = new MutationObserver(() => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = window.setTimeout(() => {
      if (enabled) {
        applyWidth(currentWidthPercent);
      }
      debounceTimer = null;
    }, 200);
  });

  const main = document.querySelector('main') || document.body;
  if (main) {
    observer.observe(main, {
      childList: true,
      subtree: true,
    });
  }

  window.addEventListener('beforeunload', () => {
    observer.disconnect();
    removeStyles();
    try {
      chrome.storage?.onChanged?.removeListener(storageChangeHandler);
    } catch {}
  });
}
