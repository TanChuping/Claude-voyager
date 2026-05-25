/**
 * User Message LaTeX Renderer
 * Renders LaTeX math ($...$ and $$...$$) in user-typed messages.
 *
 * Target DOM structure (ChatGPT):
 *   span.user-query-bubble-with-background
 *     鈹斺攢 span.horizontal-container
 *          鈹斺攢 div.query-text.gds-body-l
 *               鈹溾攢 span.cdk-visually-hidden  ("浣犺" / "You said")
 *               鈹斺攢 p.query-text-line.ng-star-inserted  鈫?processed here
 */
import katex from 'katex';

/**
 * Selector for Claude user-message paragraph elements.
 *
 * Claude already renders LaTeX in *assistant* messages via its own KaTeX
 * pipeline, but user-typed messages render as plain `<p>` blocks — so
 * "$E=mc^2$" shows up literally instead of as math.  This module fills
 * that gap for user messages only.
 *
 * `[data-testid="user-message"] p` matches every paragraph inside the
 * user message bubble (probed live on claude.ai).  We additionally skip
 * any `<p>` that already contains a `.katex` subtree (rendered by a
 * prior pass or by Claude itself) — see `processElement` below.
 *
 * Legacy ChatGPT/Gemini fallback `p.query-text-line` is also included so
 * the same code keeps working if ever ported back, but on claude.ai it
 * matches zero elements.
 */
const USER_MSG_SELECTOR = '[data-testid="user-message"] p, p.query-text-line';

type Segment = { kind: 'text'; value: string } | { kind: 'math'; value: string; display: boolean };

/**
 * Detect a currency-like pattern starting at position i (the `$`).
 * Matches: $5, $3.50, $1,000, $100K 鈥?i.e. $ followed by digits (with
 * optional comma/period grouping) and then a word boundary (space, end,
 * punctuation, or closing $).
 *
 * Returns the index to resume scanning from, or -1 if not currency.
 */
function tryCurrencySkip(text: string, i: number): number {
  let j = i + 1;
  if (j >= text.length || !/\d/.test(text[j])) return -1;

  // Consume digits, commas, periods (e.g. 1,000.50)
  while (j < text.length && /[\d,.]/.test(text[j])) j++;

  // After the numeric part, check what follows:
  const next = text[j] as string | undefined;
  // Currency if followed by: end of string, space, punctuation, or closing $
  if (next === undefined || /[\s,;:!?)}\]]/.test(next)) return j;
  // $5$ pattern 鈥?closing $ followed by non-$
  if (next === '$' && text[j + 1] !== '$') return j + 1;

  // Common currency suffixes: $100K, $5M, $2B, $5m, $1k, $3T
  // Accept if a single letter suffix is followed by a word boundary
  if (next && /[KkMmBbTt]/.test(next)) {
    const afterSuffix = text[j + 1] as string | undefined;
    if (afterSuffix === undefined || /[\s,;:!?)}\]]/.test(afterSuffix)) return j + 1;
    if (afterSuffix === '$' && text[j + 2] !== '$') return j + 2;
  }

  // Followed by a letter/operator/backslash 鈫?likely math (e.g. $2x+1$, $10^2$)
  return -1;
}

/**
 * Split text into plain-text and LaTeX ($$...$$, $...$) segments.
 * Display math ($$) takes priority over inline ($).
 *
 * Currency amounts ($5, $3.50, $1,000) are detected by lookahead after
 * the digit sequence. Math that starts with digits ($2x+1$, $10^2$) is
 * correctly parsed because the digit sequence is followed by a non-boundary
 * character.
 */
export function parseSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let textStart = 0;

  while (i < text.length) {
    if (text[i] !== '$') {
      i++;
      continue;
    }

    const display = text[i + 1] === '$';
    const openLen = display ? 2 : 1;

    // For inline $, try to detect currency patterns before searching for closing $
    if (!display) {
      const skipTo = tryCurrencySkip(text, i);
      if (skipTo !== -1) {
        i = skipTo;
        continue;
      }
    }

    // Find the closing delimiter
    let closeIdx: number;
    if (display) {
      closeIdx = text.indexOf('$$', i + openLen);
    } else {
      // Find a standalone $ (not part of $$)
      closeIdx = -1;
      let search = i + openLen;
      while (search < text.length) {
        const idx = text.indexOf('$', search);
        if (idx === -1) break;
        // Skip if this $ is part of a $$ sequence
        if (text[idx + 1] === '$' || (idx > 0 && text[idx - 1] === '$')) {
          search = idx + 1;
          continue;
        }
        closeIdx = idx;
        break;
      }
    }

    if (closeIdx === -1) {
      // No closing delimiter 鈥?treat this $ as plain text and move on
      i++;
      continue;
    }

    const mathValue = text.slice(i + openLen, closeIdx);

    // Skip empty content
    if (!display && !mathValue.trim()) {
      i = closeIdx + 1;
      continue;
    }

    // Flush accumulated plain text
    if (i > textStart) {
      out.push({ kind: 'text', value: text.slice(textStart, i) });
    }

    out.push({ kind: 'math', value: mathValue, display });

    i = closeIdx + openLen;
    textStart = i;
  }

  // Remaining plain text
  if (textStart < text.length) {
    out.push({ kind: 'text', value: text.slice(textStart) });
  }

  return out;
}

/**
 * Render LaTeX in a single user message paragraph element.
 */
function processElement(el: HTMLElement): void {
  if (el.dataset.userLatexProcessed) return;

  // Skip if Claude (or a prior pass) already rendered KaTeX in this
  // paragraph.  Re-rendering would duplicate spans and corrupt the layout.
  if (el.querySelector('.katex')) {
    el.dataset.userLatexProcessed = '1';
    return;
  }

  const raw = el.textContent ?? '';

  // Quick exit: no $ means no LaTeX
  if (!raw.includes('$')) {
    el.dataset.userLatexProcessed = '1';
    return;
  }

  const segments = parseSegments(raw);
  const hasMath = segments.some((s) => s.kind === 'math');

  if (!hasMath) {
    el.dataset.userLatexProcessed = '1';
    return;
  }

  const frag = document.createDocumentFragment();

  for (const seg of segments) {
    if (seg.kind === 'text') {
      frag.appendChild(document.createTextNode(seg.value));
    } else {
      const span = document.createElement('span');
      span.className = seg.display ? 'gv-user-latex-display' : 'gv-user-latex-inline';
      try {
        span.innerHTML = katex.renderToString(seg.value, {
          displayMode: seg.display,
          throwOnError: false,
          output: 'html',
        });
      } catch {
        // Fallback: show original delimiters
        span.textContent = seg.display ? `$$${seg.value}$$` : `$${seg.value}$`;
      }
      frag.appendChild(span);
    }
  }

  // Preserve original text for downstream features (export, timeline)
  el.dataset.userLatexOriginal = raw;
  // Replace element content with rendered output
  el.textContent = '';
  el.appendChild(frag);
  el.dataset.userLatexProcessed = '1';
}

/** Scan all currently visible user message lines. */
function processAll(): void {
  document.querySelectorAll<HTMLElement>(USER_MSG_SELECTOR).forEach(processElement);
}

let observer: MutationObserver | null = null;
let copyInterceptorInstalled = false;

/**
 * Selector for Claude's per-message Copy button.  The same data-testid
 * appears on every message's action toolbar (verified via browser-harness).
 */
const COPY_BUTTON_SELECTOR = 'button[data-testid="action-bar-copy"]';

/**
 * Collect the pre-render text of all paragraphs inside a user message,
 * joined with newlines.  Each `<p>` may have:
 *   - `dataset.userLatexOriginal`  → set by `processElement` after we
 *     replaced the raw "$...$" text with rendered KaTeX HTML.  Use this.
 *   - no dataset flag              → either we skipped it (no LaTeX) or
 *     we haven't processed it yet.  Fall back to live textContent.
 */
function collectOriginalUserText(userMsg: HTMLElement): string {
  const paragraphs = Array.from(userMsg.querySelectorAll('p'));
  if (paragraphs.length === 0) {
    return userMsg.textContent ?? '';
  }
  return paragraphs
    .map((p) => p.dataset.userLatexOriginal ?? p.textContent ?? '')
    .join('\n')
    .trimEnd();
}

/**
 * Walk up from the Copy button until we find an ancestor that also
 * contains a `[data-testid="user-message"]` bubble — that's the turn
 * this Copy button belongs to.  Returns null when the Copy is on an
 * assistant message (no user-message bubble in the same subtree).
 */
function findUserMessageForCopyButton(copyBtn: Element): HTMLElement | null {
  let ancestor: Element | null = copyBtn.parentElement;
  while (ancestor && ancestor !== document.body) {
    const candidate = ancestor.querySelector<HTMLElement>('[data-testid="user-message"]');
    if (candidate) return candidate;
    ancestor = ancestor.parentElement;
  }
  return null;
}

/**
 * Intercept clicks on Claude's per-message Copy button so user messages
 * we've LaTeX-processed copy the ORIGINAL `$...$` source instead of the
 * rendered KaTeX (whose flattened textContent reads like "E=mc2" — the
 * "^" superscript collapses, the `$` delimiters vanish, the user gets
 * unusable garbage when they paste).
 *
 * Listener is installed at `document` in capture phase so we fire before
 * any element-level handler Claude attached to the button (same reasoning
 * as sendBehavior — capture phase + early registration wins the race).
 * `stopImmediatePropagation` then halts the event so Claude's own copy
 * handler never runs and can't overwrite our clipboard write.
 *
 * Pass-through cases (we do nothing, Claude's native copy proceeds):
 *   - Copy on assistant messages
 *   - Copy on user messages we haven't processed (no `$...$` content)
 */
function installCopyInterceptor(): void {
  if (copyInterceptorInstalled) return;

  // Single handler bound to multiple event names.  Bind on the FULL
  // pointer/click sequence (pointerdown → mousedown → click) so:
  //   1. If Claude's copy fires on pointerdown (some libraries do this
  //      to avoid 300ms tap delay), we still get there first.
  //   2. If Claude's copy fires on click, our pointerdown write happens
  //      first AND our click write reinforces it.
  // navigator.clipboard.writeText is idempotent — writing the same text
  // twice from us is harmless; the only race risk is Claude's write
  // landing AFTER ours, which can't happen if we intercept the entire
  // sequence with `stopImmediatePropagation`.
  const handle = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const copyBtn = target.closest(COPY_BUTTON_SELECTOR);
    if (!copyBtn) return;

    const userMsg = findUserMessageForCopyButton(copyBtn);
    if (!userMsg) return; // assistant message — leave Claude's copy alone

    const hasProcessed = userMsg.querySelector('p[data-user-latex-original]');
    if (!hasProcessed) return; // we didn't render this — textContent is fine

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const text = collectOriginalUserText(userMsg);
    if (!text) return;

    void navigator.clipboard.writeText(text).catch((err) => {
      console.warn('[Claude-Voyager] user-latex copy override failed:', err);
    });
  };

  for (const evtName of ['pointerdown', 'mousedown', 'click'] as const) {
    document.addEventListener(evtName, handle, { capture: true });
  }
  copyInterceptorInstalled = true;
}

/**
 * Start rendering LaTeX in user messages.
 * Processes existing messages immediately and watches for new ones.
 */
export function startUserLatex(): void {
  // Process messages already on the page
  processAll();

  // Install the Copy-button override regardless of whether anything has
  // been processed yet — messages render after the script boots.
  installCopyInterceptor();

  if (observer) return;

  let debounceTimer: ReturnType<typeof setTimeout>;
  observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processAll, 300);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}
