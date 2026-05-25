/**
 * Adjusts the chat message column width on claude.ai based on user
 * settings (stored as a viewport percentage in `claudeChatWidth`).
 *
 * Claude's column is constructed from two nested Tailwind `max-w-3xl`
 * divs (verified by browser-harness):
 *   - OUTER:  div.max-w-3xl.mx-auto.flex.w-full.flex-1.flex-col.md\:px-2
 *             — wraps both the message scroll-area AND the sticky composer.
 *   - INNER:  div.max-w-3xl.mx-auto.w-full.px-4.pt-1
 *             — the message column proper (sits inside the scroll-area).
 *
 * Strategy: lift the OUTER `max-w-3xl` cap entirely (otherwise expanding
 * the inner does nothing), then set the INNER to the user's percent.  The
 * composer has its own width adjuster (editInputWidth) that pins the
 * sticky-bottom composer wrapper, so the two settings stay independent.
 */

const STYLE_ID = 'cv-chat-width';
const DEFAULT_PERCENT = 70;
const MIN_PERCENT = 30;
const MAX_PERCENT = 100;
const LEGACY_BASELINE_PX = 1200;

const VALUE_KEY = 'claudeChatWidth';
const ENABLED_KEY = 'cvChatWidthEnabled';

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

function applyWidth(widthPercent: number) {
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
     * Lift the OUTER max-w-3xl cap (the one with md:px-2) so the inner
     * column has room to expand.  Without this, setting max-width on the
     * inner column does nothing because the outer is already clamped to
     * 768px (max-w-3xl).
     */
    div.max-w-3xl.mx-auto.flex.w-full.flex-1.flex-col.md\\:px-2,
    div.max-w-3xl.md\\:px-2 {
      max-width: 100vw !important;
    }

    /*
     * The message column proper.  Recognizable by the .px-4.pt-1 combo
     * which is unique to it (the composer wrappers don't have pt-1).
     */
    div.max-w-3xl.mx-auto.w-full.px-4.pt-1,
    div.max-w-3xl.px-4.pt-1 {
      max-width: ${widthValue} !important;
      width: min(100%, ${widthValue}) !important;
    }

    /*
     * Safety net: if Claude renames classes, target by structure —
     * any max-w-3xl that contains a rendered turn.  Some browsers don't
     * support :has() (Firefox <121); the explicit class selectors above
     * cover those.
     */
    @supports selector(:has(*)) {
      div.max-w-3xl:has([data-test-render-count]) {
        max-width: ${widthValue} !important;
      }
    }
  `;
}

function removeStyles() {
  const style = document.getElementById(STYLE_ID);
  if (style) {
    style.remove();
  }
}

export function startChatWidthAdjuster() {
  let currentWidthPercent = DEFAULT_PERCENT;
  let enabled = false;

  // Load initial state — request without defaults so we can distinguish
  // "key never existed" (upgrade) from "explicitly set to false".
  chrome.storage?.sync?.get([VALUE_KEY, ENABLED_KEY], (res) => {
    const storedWidth = res?.[VALUE_KEY];
    const numericStoredWidth = typeof storedWidth === 'number' ? storedWidth : DEFAULT_PERCENT;
    const normalized = normalizePercent(numericStoredWidth, DEFAULT_PERCENT);
    currentWidthPercent = normalized;

    const enabledRaw = res?.[ENABLED_KEY];
    if (enabledRaw === undefined) {
      // Upgrade path: auto-enable if user had previously customized.
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
        console.warn('[Claude-Voyager] Failed to migrate chat width:', e);
      }
    }
  });

  // Respond to slider changes from the popup.
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
            console.warn('[Claude-Voyager] Failed to normalize chat width on change:', e);
          }
        }
      }
    }
  };

  chrome.storage?.onChanged?.addListener(storageChangeHandler);

  // Claude re-mounts the message scroll-area on conversation switches, so
  // re-apply the styles on relevant DOM changes.
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

  window.addEventListener(
    'beforeunload',
    () => {
      observer.disconnect();
      removeStyles();
      try {
        chrome.storage?.onChanged?.removeListener(storageChangeHandler);
      } catch (e) {
        console.error('[Claude-Voyager] Failed to remove storage listener on unload:', e);
      }
    },
    { once: true },
  );
}
