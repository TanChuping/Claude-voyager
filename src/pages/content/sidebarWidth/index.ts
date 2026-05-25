/* Adjust ChatGPT sidebar width through its --sidebar-width CSS variable. */
const STYLE_ID = 'gv-sidebar-width-style';
const DEFAULT_PERCENT = 26;
const MIN_PERCENT = 15;
const MAX_PERCENT = 45;
const LEGACY_BASELINE_PX = 1200;

const DEFAULT_PX = Math.round((DEFAULT_PERCENT / 100) * LEGACY_BASELINE_PX); // 312px
const MIN_PX = Math.round((MIN_PERCENT / 100) * LEGACY_BASELINE_PX); // 180px
const MAX_PX = Math.round((MAX_PERCENT / 100) * LEGACY_BASELINE_PX); // 540px
const SEARCH_HIT_DEBUG_THROTTLE_MS = 1200;

let searchHitDebugBound = false;
let lastSearchHitDebugAt = 0;

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const normalizePercent = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  if (value > MAX_PERCENT) {
    const approx = (value / LEGACY_BASELINE_PX) * 100;
    return clampNumber(approx, MIN_PERCENT, MAX_PERCENT);
  }
  return clampNumber(value, MIN_PERCENT, MAX_PERCENT);
};

const normalizePx = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return clampNumber(value, MIN_PX, MAX_PX);
};

function normalizeWidth(value: number): { normalized: number; unit: 'px' | 'percent' } {
  if (!Number.isFinite(value)) return { normalized: DEFAULT_PX, unit: 'px' };
  if (value > MAX_PERCENT) {
    return { normalized: normalizePx(value, DEFAULT_PX), unit: 'px' };
  }
  return { normalized: normalizePercent(value, DEFAULT_PERCENT), unit: 'percent' };
}

function buildStyle(widthValue: number): string {
  const { normalized, unit } = normalizeWidth(widthValue);

  const clampedWidth = unit === 'px' ? `${normalized}px` : `clamp(200px, ${normalized}vw, 800px)`;

  // Claude.ai's sidebar is the <nav aria-label="Sidebar"> with an inline
  // `style="width: 18rem"`.  Its parent `<div class="fixed lg:sticky
  // z-sidebar">` carries the same inline width.  Both need overriding to
  // change the visible column width.  Tailwind compiles `lg:sticky` to a
  // class name with a backslash-escaped colon (`.lg\:sticky`).
  //
  // The Gemini `--sidebar-width` CSS variable rule is kept as a no-op on
  // Claude (cheap defensive coupling for any future Claude variant that
  // adopts the variable pattern).
  return `
    /* Claude — main sidebar nav + its fixed/sticky outer wrapper */
    nav[aria-label="Sidebar"],
    div.fixed.lg\\:sticky.z-sidebar,
    div.fixed.z-sidebar {
      width: ${clampedWidth} !important;
      max-width: ${clampedWidth} !important;
      min-width: 0 !important;
      flex-basis: ${clampedWidth} !important;
    }

    /* Legacy / variable-based fallback for Gemini-like layouts */
    :root {
      --sidebar-width: ${clampedWidth} !important;
    }
  `;
}

function ensureStyleEl(): HTMLStyleElement {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.documentElement.appendChild(style);
  }
  return style;
}

function applyWidth(widthValue: number): void {
  const style = ensureStyleEl();
  style.textContent = buildStyle(widthValue);
}

function removeStyles(): void {
  const style = document.getElementById(STYLE_ID);
  if (style) style.remove();
}

function formatElementForDebug(element: Element | null): string {
  if (!element) return '(none)';
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const classNames = element.classList.length ? `.${Array.from(element.classList).join('.')}` : '';
  return `${tag}${id}${classNames}`;
}

function setupSearchButtonHitTestDebug(): void {
  if (searchHitDebugBound) return;
  searchHitDebugBound = true;

  const onPointerDownCapture = (event: PointerEvent) => {
    const searchButton = document.querySelector<HTMLElement>('search-nav-button button');
    if (!searchButton) return;

    const rect = searchButton.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const { clientX: x, clientY: y } = event;
    const isInSearchRect = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    if (!isInSearchRect) return;

    const target = event.target instanceof Element ? event.target : null;
    if (target && searchButton.contains(target)) return;

    const now = Date.now();
    if (now - lastSearchHitDebugAt < SEARCH_HIT_DEBUG_THROTTLE_MS) return;
    lastSearchHitDebugAt = now;

    const stack = document.elementsFromPoint(x, y).slice(0, 6);
    const top = stack[0] ?? null;
    const topStyle = top ? window.getComputedStyle(top) : null;

    console.warn('[Claude-Voyager][sidebarWidth debug] Search button hit blocked', {
      point: { x, y },
      target: formatElementForDebug(target),
      searchButton: formatElementForDebug(searchButton),
      topElement: formatElementForDebug(top),
      topElementPointerEvents: topStyle?.pointerEvents ?? null,
      topElementZIndex: topStyle?.zIndex ?? null,
      stack: stack.map((element) => formatElementForDebug(element)),
    });
  };

  window.addEventListener('pointerdown', onPointerDownCapture, true);
  window.addEventListener(
    'beforeunload',
    () => {
      window.removeEventListener('pointerdown', onPointerDownCapture, true);
      searchHitDebugBound = false;
    },
    { once: true },
  );
}

const ENABLED_KEY = 'cvSidebarWidthEnabled';

/** Initialize and start the sidebar width adjuster.
 *
 * The popup exposes no enable/disable toggle for sidebar width (only the
 * slider) so this adjuster is **always active**: the user's stored value
 * (or the default) is applied on every page load.  The legacy
 * `cvSidebarWidthEnabled` key is read but is no longer authoritative —
 * setting it to false would simply repaint with the default width.
 */
export function startSidebarWidthAdjuster(): void {
  let currentWidthValue = DEFAULT_PX;
  setupSearchButtonHitTestDebug();

  // 1) Read initial state and apply unconditionally.
  try {
    chrome.storage?.sync?.get(['claudeSidebarWidth', ENABLED_KEY], (res) => {
      const rawW = res?.claudeSidebarWidth;
      const w = Number.isFinite(Number(rawW)) ? Number(rawW) : DEFAULT_PX;
      const { normalized } = normalizeWidth(w);
      currentWidthValue = normalized;
      applyWidth(currentWidthValue);

      if (Number.isFinite(w) && w !== normalized) {
        try {
          chrome.storage?.sync?.set({ claudeSidebarWidth: normalized });
        } catch (err) {
          console.warn('[Claude-Voyager] Failed to migrate sidebar width:', err);
        }
      }
    });
  } catch (e) {
    console.error('[Claude-Voyager] Failed to get sidebar width from storage:', e);
  }

  // 2) Respond to storage changes (from Popup slider adjustment).
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'sync') return;

      if (changes.claudeSidebarWidth) {
        const w = Number(changes.claudeSidebarWidth.newValue);
        if (Number.isFinite(w)) {
          const { normalized } = normalizeWidth(w);
          currentWidthValue = normalized;
          applyWidth(currentWidthValue);

          if (normalized !== w) {
            try {
              chrome.storage?.sync?.set({ claudeSidebarWidth: normalized });
            } catch (err) {
              console.warn('[Claude-Voyager] Failed to normalize sidebar width:', err);
            }
          }
        }
      }
    });
  } catch (e) {
    console.error('[Claude-Voyager] Failed to add storage listener for sidebar width:', e);
  }

  // // 3) Listen for DOM changes (<bard-sidenav> may be lazily mounted)
  // let debounceTimer: number | null = null;
  // const observer = new MutationObserver(() => {
  //   if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  //   debounceTimer = window.setTimeout(() => {
  //     applyWidth(currentWidthValue);
  //     debounceTimer = null;
  //   }, 150);
  // });

  // const root = document.documentElement || document.body;
  // if (root) {
  //   observer.observe(root, { childList: true, subtree: true });
  // }

  // 4) Cleanup
  window.addEventListener('beforeunload', () => {
    // observer.disconnect();
    removeStyles();
  });
}
