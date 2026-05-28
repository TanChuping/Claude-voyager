/**
 * "Undo incognito" button injected to the LEFT of Claude's own
 * "Exit incognito" button while incognito mode is active.
 *
 * Claude's header layout makes our job easy compared to ChatGPT:
 *   - The Exit-incognito button lives in a single flex row at the
 *     top right of the page: `div.fixed.z-header.right-3` with
 *     `display:flex; flex-direction:row; gap-3.5`.
 *   - It's only rendered while incognito is active, so its mere
 *     presence is also our visibility signal — no aria-label
 *     enter/leave label flip to track.
 *
 * Visibility rule: button is mounted iff Exit-incognito exists in
 * the DOM AND the URL still carries `?incognito`.  Removed otherwise.
 * Re-checked on every observed DOM mutation under the header tree.
 *
 * Adaptive layout: at narrow viewports the label collapses to icon-
 * only (a ResizeObserver on the header row monitors the available
 * width).  The tooltip preserves the full label so power users on
 * tiny screens still get the affordance.
 */
import { runTempChatRegret } from './orchestrator';
import { t } from './i18n';

const TAG = 'data-cv-temp-regret-btn';
const EXIT_INCOGNITO_SELECTOR = 'button[aria-label="Exit incognito"]';
// Viewport-width breakpoint below which we collapse to icon-only.  We
// used to gate on `row.clientWidth` but Claude's `gap-3.5 right-3` row
// hugs its content, so it's always ~80–120 px wide regardless of how
// much space is actually available — that made the label hide
// permanently and people couldn't find the feature.  Window width
// reflects the *real* available room.
const ICON_ONLY_VIEWPORT_PX = 520;

let observer: MutationObserver | null = null;
let resizeObs: ResizeObserver | null = null;
let mountedRow: HTMLElement | null = null;

function isIncognitoActive(): boolean {
  try {
    if (new URL(window.location.href).searchParams.has('incognito')) {
      return !!document.querySelector(EXIT_INCOGNITO_SELECTOR);
    }
  } catch {
    /* malformed URL — fall back to DOM presence alone */
  }
  return !!document.querySelector(EXIT_INCOGNITO_SELECTOR);
}

function buildIcon(): SVGSVGElement {
  // Curved undo arrow — visually reads as "take back / reverse".
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const head = document.createElementNS(ns, 'path');
  head.setAttribute('d', 'M9 14L4 9l5-5');
  svg.appendChild(head);

  const tail = document.createElementNS(ns, 'path');
  tail.setAttribute('d', 'M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5h-4');
  svg.appendChild(tail);

  return svg;
}

function buildButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute(TAG, '1');
  btn.setAttribute('aria-label', t('tempChatRegretButton'));
  btn.title = t('tempChatRegretButtonTooltip');
  // Pick up Claude's own header-button styling.  Concrete class names
  // change between releases, so we lean on our own scoped class plus
  // the Tailwind tokens Claude reliably exposes (`text-text-100`,
  // hover bg, rounded corners).
  btn.className =
    'cv-temp-regret-btn inline-flex items-center gap-1 px-2 h-8 ' +
    'rounded-lg text-sm font-medium text-text-100 ' +
    'hover:bg-bg-200/60 transition-colors';
  btn.appendChild(buildIcon());

  const label = document.createElement('span');
  label.className = 'cv-temp-regret-btn__label';
  label.textContent = t('tempChatRegretButton');
  btn.appendChild(label);

  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void runTempChatRegret();
  });

  return btn;
}

function applyCompactMode(btn: HTMLElement, compact: boolean): void {
  const label = btn.querySelector<HTMLElement>('.cv-temp-regret-btn__label');
  if (!label) return;
  label.style.display = compact ? 'none' : '';
  btn.classList.toggle('cv-temp-regret-btn--compact', compact);
}

function watchRowWidth(_row: HTMLElement, btn: HTMLElement): void {
  if (resizeObs) {
    resizeObs.disconnect();
    resizeObs = null;
  }
  // We observe the documentElement instead of the row — the row is
  // content-hugging and its clientWidth doesn't reflect the actual
  // available room.  The viewport does.
  resizeObs = new ResizeObserver(() => {
    applyCompactMode(btn, window.innerWidth < ICON_ONLY_VIEWPORT_PX);
  });
  resizeObs.observe(document.documentElement);
  applyCompactMode(btn, window.innerWidth < ICON_ONLY_VIEWPORT_PX);
}

/**
 * Walk up from a starting node and return the nearest ancestor whose
 * computed `display` is a horizontal flex row.  This is the only place
 * a sibling `<button>` will lay out side-by-side with the existing
 * row instead of stacking vertically.
 *
 * Also returns the immediate-child wrapper of that flex row that holds
 * `start` — we insert before THAT, not before `start` directly, since
 * Claude wraps every header button in a small empty-class `<div>` that
 * sits between the button and the flex row.
 */
function findFlexRowAnchor(
  start: HTMLElement,
): { row: HTMLElement; insertBefore: HTMLElement } | null {
  let prev: HTMLElement = start;
  let n: HTMLElement | null = start.parentElement;
  let depth = 0;
  while (n && depth < 8) {
    const cs = window.getComputedStyle(n);
    const isFlex = cs.display === 'flex' || cs.display === 'inline-flex';
    const isRow = cs.flexDirection === 'row' || cs.flexDirection === 'row-reverse';
    if (isFlex && isRow) {
      return { row: n, insertBefore: prev };
    }
    prev = n;
    n = n.parentElement;
    depth++;
  }
  return null;
}

function injectIfNeeded(): void {
  // Idempotency: if a button is already in the DOM, just make sure
  // its row tracker is still in sync; the early-out prevents the
  // mutation observer from triggering a flicker every keystroke.
  const existing = document.querySelector<HTMLElement>(`[${TAG}]`);

  if (!isIncognitoActive()) {
    existing?.remove();
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    mountedRow = null;
    return;
  }

  const exit = document.querySelector<HTMLElement>(EXIT_INCOGNITO_SELECTOR);
  if (!exit) return;

  // Claude wraps each header button in a 2–3 level deep block-display
  // `<div>` chain before reaching the actual flex row container
  // (.fixed.z-header.right-3).  Inserting as a sibling of the button
  // would land inside one of those block wrappers and stack vertically.
  const anchor = findFlexRowAnchor(exit);
  if (!anchor) return;
  const { row, insertBefore } = anchor;

  if (existing && row.contains(existing)) {
    if (mountedRow !== row) {
      mountedRow = row;
      watchRowWidth(row, existing);
    }
    return;
  }

  // Remove any orphaned instance from a previous row.
  existing?.remove();

  const btn = buildButton();
  row.insertBefore(btn, insertBefore);
  mountedRow = row;
  watchRowWidth(row, btn);
}

export function startTempChatRegretButton(): void {
  injectIfNeeded();
  if (observer) return;
  observer = new MutationObserver(() => {
    // Debounce-light: any header churn triggers one re-check.  The
    // injectIfNeeded path is cheap when the button is already in
    // place, so we don't bother debouncing further.
    injectIfNeeded();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function stopTempChatRegretButton(): void {
  observer?.disconnect();
  observer = null;
  resizeObs?.disconnect();
  resizeObs = null;
  document.querySelectorAll(`[${TAG}]`).forEach((n) => n.remove());
  mountedRow = null;
}
