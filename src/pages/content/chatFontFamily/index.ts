/**
 * Applies a user-selected font family to Claude.ai message text and the
 * composer.
 *
 * Presets (storage key: cvChatFontFamily):
 *   - 'default'  →  no override (Claude's own typeface)
 *   - 'gemini'   →  Google-Sans-style stack (will silently fall back to
 *                   the user's system fallback if not installed locally)
 *   - 'gpt'      →  Söhne / ColfaxAI-style stack (same caveat)
 *   - 'custom'   →  user-imported font from the popup (woff2/woff/ttf/otf
 *                   base64 stored in chrome.storage.LOCAL because sync has
 *                   an 8 KB per-item cap)
 *
 * The preset selection + custom-font metadata live in storage.sync so they
 * round-trip across devices; only the heavy base64 payload lives in local.
 * If the user re-imports a custom font on another device the binary won't
 * be present there — the preset just degrades gracefully to the system
 * fallback for "custom" until they import again.
 */

const STYLE_ID = 'cv-chat-font-family';
const FONT_FACE_ID = 'cv-chat-font-family-face';
const CUSTOM_FONT_NAME = 'cv-custom-chat-font';

const ENABLED_KEY = 'cvChatFontFamilyEnabled';
const FAMILY_KEY = 'cvChatFontFamily';
const CUSTOM_NAME_KEY = 'cvChatCustomFontName';
const CUSTOM_FORMAT_KEY = 'cvChatCustomFontFormat';
const CUSTOM_DATA_KEY = 'cvChatCustomFontData';

type FontPreset = 'default' | 'gemini' | 'gpt' | 'custom';

const PRESETS: Record<Exclude<FontPreset, 'default' | 'custom'>, string> = {
  // Gemini's UI shipped with Google Sans / Google Sans Text — users who
  // have Gemini installed locally typically have these in their font book.
  gemini: `'Google Sans Text', 'Google Sans', 'Product Sans', Roboto, 'Helvetica Neue', Arial, sans-serif`,
  // ChatGPT uses Söhne (commercial) on its production app and ColfaxAI in
  // their marketing site.  Most users won't have Söhne licensed; the rest
  // of the stack provides a workable fallback.
  gpt: `'Söhne', 'ColfaxAI', 'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif`,
};

function isValidPreset(value: unknown): value is FontPreset {
  return value === 'default' || value === 'gemini' || value === 'gpt' || value === 'custom';
}

function extToCssFormat(ext: string): string {
  switch (ext) {
    case 'woff2':
      return 'woff2';
    case 'woff':
      return 'woff';
    case 'ttf':
      return 'truetype';
    case 'otf':
      return 'opentype';
    default:
      return 'truetype';
  }
}

function buildFontFaceCss(name: string, ext: string, dataUrl: string): string {
  const cssFormat = extToCssFormat(ext);
  return `
    @font-face {
      font-family: '${CUSTOM_FONT_NAME}';
      src: url('${dataUrl}') format('${cssFormat}');
      font-display: swap;
      font-weight: 100 900;
      font-style: normal;
    }
    /* Also register under the user's chosen display name so dev tools and
       any consumer querying by-name resolves to the imported bytes. */
    @font-face {
      font-family: ${JSON.stringify(name)};
      src: url('${dataUrl}') format('${cssFormat}');
      font-display: swap;
      font-weight: 100 900;
      font-style: normal;
    }
  `;
}

function buildAppliedStack(preset: FontPreset, customName: string | null): string | null {
  if (preset === 'default') return null;
  if (preset === 'custom') {
    if (customName) {
      return `'${CUSTOM_FONT_NAME}', ${JSON.stringify(customName)}, system-ui, -apple-system, sans-serif`;
    }
    // Custom selected but no font imported yet — fall back to system.
    return `system-ui, -apple-system, 'Helvetica Neue', sans-serif`;
  }
  return PRESETS[preset];
}

function applyStyles(stack: string | null, fontFace: string | null) {
  // 1) @font-face block (only when custom)
  let faceEl = document.getElementById(FONT_FACE_ID) as HTMLStyleElement | null;
  if (fontFace) {
    if (!faceEl) {
      faceEl = document.createElement('style');
      faceEl.id = FONT_FACE_ID;
      document.head.appendChild(faceEl);
    }
    faceEl.textContent = fontFace;
  } else if (faceEl) {
    faceEl.remove();
  }

  // 2) Application rules
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!stack) {
    if (styleEl) styleEl.remove();
    return;
  }
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = `
    /* Claude — user message bubble */
    [data-testid="user-message"],
    [data-testid="user-message"] *,
    [data-user-message-bubble="true"] {
      font-family: ${stack} !important;
    }

    /* Claude — assistant response markdown */
    .font-claude-response,
    .font-claude-response *:not(pre):not(code):not(.cm-content):not(.cm-content *) {
      font-family: ${stack} !important;
    }

    /* Composer (ProseMirror / tiptap editor) */
    .ProseMirror,
    .ProseMirror *,
    .tiptap,
    .tiptap *,
    fieldset .ProseMirror,
    fieldset .ProseMirror * {
      font-family: ${stack} !important;
    }

    /* Code blocks and inline code intentionally keep their monospace —
       overriding font-family there would break alignment + readability. */
  `;
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
  document.getElementById(FONT_FACE_ID)?.remove();
}

interface SyncState {
  enabled: boolean;
  preset: FontPreset;
  customName: string | null;
  customFormat: string | null;
}

interface LocalState {
  customData: string | null; // data:URL or base64 — we accept both, normalize below
}

let sync: SyncState = {
  enabled: false,
  preset: 'default',
  customName: null,
  customFormat: null,
};

let localState: LocalState = { customData: null };

function normalizeDataUrl(data: string, format: string): string {
  if (data.startsWith('data:')) return data;
  // Bare base64 — wrap it with a font mime type.
  const mime =
    format === 'woff2'
      ? 'font/woff2'
      : format === 'woff'
        ? 'font/woff'
        : format === 'ttf'
          ? 'font/ttf'
          : format === 'otf'
            ? 'font/otf'
            : 'application/octet-stream';
  return `data:${mime};base64,${data}`;
}

function reapply() {
  if (!sync.enabled) {
    removeStyles();
    return;
  }
  const stack = buildAppliedStack(sync.preset, sync.customName);
  let fontFace: string | null = null;
  if (
    sync.preset === 'custom' &&
    localState.customData &&
    sync.customName &&
    sync.customFormat
  ) {
    const url = normalizeDataUrl(localState.customData, sync.customFormat);
    fontFace = buildFontFaceCss(sync.customName, sync.customFormat, url);
  }
  applyStyles(stack, fontFace);
}

export function startChatFontFamilyAdjuster(): void {
  // Initial load — sync side first, then local.
  chrome.storage?.sync?.get(
    [ENABLED_KEY, FAMILY_KEY, CUSTOM_NAME_KEY, CUSTOM_FORMAT_KEY],
    (res) => {
      sync = {
        enabled: res?.[ENABLED_KEY] === true,
        preset: isValidPreset(res?.[FAMILY_KEY]) ? res[FAMILY_KEY] : 'default',
        customName: typeof res?.[CUSTOM_NAME_KEY] === 'string' ? res[CUSTOM_NAME_KEY] : null,
        customFormat:
          typeof res?.[CUSTOM_FORMAT_KEY] === 'string' ? res[CUSTOM_FORMAT_KEY] : null,
      };
      chrome.storage?.local?.get([CUSTOM_DATA_KEY], (lres) => {
        localState = {
          customData:
            typeof lres?.[CUSTOM_DATA_KEY] === 'string' ? lres[CUSTOM_DATA_KEY] : null,
        };
        reapply();
      });
    },
  );

  const storageChangeHandler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area === 'sync') {
      let touched = false;
      if (changes[ENABLED_KEY]) {
        sync.enabled = changes[ENABLED_KEY].newValue === true;
        touched = true;
      }
      if (changes[FAMILY_KEY]) {
        const v = changes[FAMILY_KEY].newValue;
        sync.preset = isValidPreset(v) ? v : 'default';
        touched = true;
      }
      if (changes[CUSTOM_NAME_KEY]) {
        sync.customName =
          typeof changes[CUSTOM_NAME_KEY].newValue === 'string'
            ? changes[CUSTOM_NAME_KEY].newValue
            : null;
        touched = true;
      }
      if (changes[CUSTOM_FORMAT_KEY]) {
        sync.customFormat =
          typeof changes[CUSTOM_FORMAT_KEY].newValue === 'string'
            ? changes[CUSTOM_FORMAT_KEY].newValue
            : null;
        touched = true;
      }
      if (touched) reapply();
    } else if (area === 'local') {
      if (changes[CUSTOM_DATA_KEY]) {
        localState.customData =
          typeof changes[CUSTOM_DATA_KEY].newValue === 'string'
            ? changes[CUSTOM_DATA_KEY].newValue
            : null;
        reapply();
      }
    }
  };

  chrome.storage?.onChanged?.addListener(storageChangeHandler);

  window.addEventListener(
    'beforeunload',
    () => {
      removeStyles();
      try {
        chrome.storage?.onChanged?.removeListener(storageChangeHandler);
      } catch {}
    },
    { once: true },
  );
}
