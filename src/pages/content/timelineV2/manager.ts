/**
 * TimelineV2 — Claude-native timeline manager.
 *
 * Architecture inspired by claude-nexus (https://github.com/Qiuner/claude-nexus,
 * MIT — node-discovery strategy via `[data-test-render-count]` wrappers) and
 * by GPT-Voyager's `pages/content/timeline/manager.ts` (visual layout patterns:
 * dot indicators, scroll-thumb proportional drag, active-index locking during
 * smooth scroll). We adapt both to vanilla TS so it can drop into our
 * existing non-React content-script entry, retheme to Claude beige+orange,
 * and add a center-mounted favorites hamburger plus per-message hover
 * toolbar that GPT-Voyager doesn't have.
 */
import { StarredMessagesService } from '../timeline/StarredMessagesService';
import type { StarredMessage } from '../timeline/starredTypes';
import {
  CONVERSATION_LINK_SELECTOR,
  MESSAGE_RENDER_WRAPPER_SELECTOR,
  SCROLL_CONTAINER_SELECTOR,
  SIDEBAR_FALLBACK_CONTAINER_SELECTOR,
  SIDEBAR_NAV_SELECTOR,
  USER_MESSAGE_SELECTOR,
} from './selectors';
import {
  mountTimelinePreviewPanel,
  type PreviewPanelHandle,
  type PreviewRow,
} from './previewPanel';
import { detectAttachments, TYPE_COLOR, type AttachmentInfo } from './attachments';

// ----- Tunables ------------------------------------------------------------

const SCROLL_OFFSET_PX = 80;
const CHAT_RESYNC_DELAY_MS = 800;
const CHAT_POLL_INTERVAL_MS = 500;
const SIDEBAR_RESYNC_DEBOUNCE_MS = 800;
const MAX_TOOLTIP_CHARS = 280;
// Text-pin storage key — per-conversation list of pins anchored to a yOffset
// inside a specific user turn. Mirrors GPT-Voyager's `gptTimelineTextPins:<conv>`.
const TEXT_PIN_STORAGE_PREFIX = 'claudeTimelineTextPins:';
const ACTIVE_LOCK_MS = 700;             // how long click-driven active stays locked
const SCROLL_ANIM_MS = 600;             // smooth-scroll duration
const MAX_VISIBLE_DOTS_BEFORE_SCROLL = 18; // beyond this we enable the thumb
const PIN_SNIPPET_MAX = 80;              // chars stored as the pin label
// Coalesce streaming mutation callbacks — a 6-character/s response would
// otherwise fire ~60 refreshNodes() per second.  120 ms feels instant for
// user actions (send/edit) while drastically cutting work during streams.
const REFRESH_DEBOUNCE_MS = 120;

const PALETTE = {
  beigeBar: 'rgba(245, 239, 227, 0.92)',
  dotIdle: '#E8A87C',
  dotActive: '#C96442',
  glow: 'rgba(201, 100, 66, 0.45)',
  pinFill: '#C96442',
  pinBadgeBg: '#C96442',
  pinBadgeText: '#FBF7EF',
  // Traditional gold for the star (user feedback: 不要橘色, 要 "正常金色")
  starGold: '#F4C430',
  starGoldDeep: '#D4A013',
  starBgTint: 'rgba(201, 100, 66, 0.18)',
  attachmentBar: '#D27450',
  trackLine: 'rgba(201, 100, 66, 0.20)',
  tooltipBg: '#FBF7EF',
  tooltipText: '#3D2A1F',
  tooltipBorder: '#E8DDC9',
  sidebarBg: '#FBF7EF',
  sidebarBorder: '#E8DDC9',
  thumbIdle: 'rgba(201, 100, 66, 0.32)',
  thumbHover: 'rgba(201, 100, 66, 0.55)',
  rail: 'rgba(91, 50, 32, 0.10)',
} as const;

const CHAT_ID_FROM_PATH = (path: string = location.pathname): string =>
  path.split('/chat/')[1]?.split('/')[0] ?? '';

const findScrollContainer = (): HTMLElement | null => {
  const el = document.querySelector(SCROLL_CONTAINER_SELECTOR);
  return el instanceof HTMLElement ? el : null;
};

const findSidebar = (): HTMLElement | null => {
  const nav = document.querySelector(SIDEBAR_NAV_SELECTOR);
  if (nav instanceof HTMLElement) return nav;
  const fb = document.querySelector(SIDEBAR_FALLBACK_CONTAINER_SELECTOR);
  return fb instanceof HTMLElement ? fb : null;
};

// ----- SVG icons -----------------------------------------------------------

const SVG_STAR_FILLED = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" width="100%" height="100%"><path d="M12 2.7l2.7 6.45 6.95.55-5.3 4.55 1.65 6.8L12 17.4 5.4 21.05l1.65-6.8L1.75 9.7l6.95-.55L12 2.7z"/></svg>`;
const SVG_STAR_OUTLINE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" width="100%" height="100%"><path d="M12 2.7l2.7 6.45 6.95.55-5.3 4.55 1.65 6.8L12 17.4 5.4 21.05l1.65-6.8L1.75 9.7l6.95-.55L12 2.7z"/></svg>`;
const SVG_HAMBURGER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" width="100%" height="100%"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`;

// ----- Types ---------------------------------------------------------------

type Node = {
  id: string;
  wrapper: Element;
  text: string;
  starred: boolean;
  attachments: AttachmentInfo[];
};

/**
 * A single text pin — a marker that lives inside a user turn at a known
 * vertical offset (yOffset, measured from the turn wrapper's top in scroll-
 * container coordinates). Stored per-conversation in localStorage.
 *
 * yOffset / yRatio are both persisted: yOffset is the live pixel value (the
 * authoritative one), yRatio is a backup ratio for cases where the turn's
 * height changes drastically (e.g. an assistant message expands as the user
 * resizes the window). xOffset/xRatio are similar for the horizontal axis.
 */
type TextPin = {
  id: string;
  turnId: string;
  xOffset: number;
  xRatio: number;
  yOffset: number;
  yRatio: number;
  text: string;
  createdAt: number;
};

type TextPinTarget = {
  marker: { id: string; element: HTMLElement };
  xOffset: number;
  xRatio: number;
  yOffset: number;
};

// ----- Storage helpers ----------------------------------------------------

function loadTextPins(chatId: string): TextPin[] {
  try {
    const raw = localStorage.getItem(TEXT_PIN_STORAGE_PREFIX + chatId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: number; pins?: TextPin[] };
    if (!parsed?.pins || !Array.isArray(parsed.pins)) return [];
    return parsed.pins.filter(
      (p) =>
        p &&
        typeof p.id === 'string' &&
        typeof p.turnId === 'string' &&
        typeof p.yOffset === 'number',
    );
  } catch {
    return [];
  }
}

function saveTextPins(chatId: string, pins: TextPin[]): void {
  try {
    const key = TEXT_PIN_STORAGE_PREFIX + chatId;
    if (pins.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({ version: 1, pins }));
  } catch {}
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function extractUserText(wrapper: Element): string {
  const el = wrapper.querySelector(USER_MESSAGE_SELECTOR);
  if (!el) return '';
  // Strip Claude's a11y prefix `<span class="sr-only">You said:</span>` so
  // it doesn't pollute tooltips, star previews, or pin labels.  Clone
  // first to avoid mutating the live DOM.
  let raw = '';
  try {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.sr-only, [aria-hidden="true"]').forEach((n) => n.remove());
    raw = clone.textContent || '';
  } catch {
    raw = el.textContent || '';
  }
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TOOLTIP_CHARS);
}

/**
 * Resolve the surrounding word at a click point, with sensible fallbacks
 * (sentence snippet, then fallbackTarget.textContent).  Stored as the
 * pin's label so the user can recognise pins from their text content.
 *
 * Adapted from GPT-Voyager's `extractTextAroundPoint`.
 */
function extractTextAroundPoint(
  clientX: number,
  clientY: number,
  fallbackTarget: HTMLElement,
): string {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  const range = doc.caretRangeFromPoint?.(clientX, clientY);
  if (range) {
    node = range.startContainer;
    offset = range.startOffset;
  } else {
    const pos = doc.caretPositionFromPoint?.(clientX, clientY);
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  }
  // Reject the caret if it landed in an sr-only / aria-hidden subtree —
  // Claude prefixes each user bubble with a `<span class="sr-only">You
  // said: </span>`, and the caret defaults to it when the click lands
  // at the start of the bubble.  Without this guard the pin label would
  // be "You said:" instead of the actual user text the user clicked on.
  const isHiddenForA11y = (n: Node | null): boolean => {
    let cur: Node | null = n;
    while (cur && cur !== document.documentElement) {
      if (cur.nodeType === Node.ELEMENT_NODE) {
        const el = cur as HTMLElement;
        if (el.classList?.contains('sr-only')) return true;
        if (el.getAttribute?.('aria-hidden') === 'true') return true;
      }
      cur = cur.parentNode;
    }
    return false;
  };
  if (node && isHiddenForA11y(node)) {
    node = null;  // fall through to fallbackTarget below
  }
  // If we landed in a text node, slice the surrounding "word".
  if (node?.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || '';
    const left = text
      .slice(0, offset)
      .search(/[^\s.,;:!?()[\]{}"'`，。！？；：（）【】《》、]*$/);
    const start = left >= 0 ? left : Math.max(0, offset - 24);
    const rightMatch = text
      .slice(offset)
      .match(/^[^\s.,;:!?()[\]{}"'`，。！？；：（）【】《》、]*/);
    const end = Math.min(text.length, offset + (rightMatch?.[0].length ?? 0));
    const word = text.slice(start, end).trim();
    if (word) return word.slice(0, PIN_SNIPPET_MAX);
    const snippet = text
      .slice(Math.max(0, offset - 24), Math.min(text.length, offset + 56))
      .trim();
    if (snippet) return snippet.slice(0, PIN_SNIPPET_MAX);
  }
  // Last resort — clean text of the surrounding element, with sr-only /
  // aria-hidden subtrees stripped (otherwise Claude's "You said:" label
  // leaks into the snippet).
  let raw = '';
  try {
    const clone = fallbackTarget.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.sr-only, [aria-hidden="true"]').forEach((n) => n.remove());
    raw = clone.textContent || '';
  } catch {
    raw = fallbackTarget.textContent || '';
  }
  return raw.replace(/\s+/g, ' ').trim().slice(0, PIN_SNIPPET_MAX);
}

// (Attachment detection now lives in `./attachments.ts` — returns the rich
// `AttachmentInfo[]` we need for type-colored chips and tooltip cards.)

// ===========================================================================

export class TimelineV2 {
  private root: HTMLDivElement | null = null;
  private bar: HTMLDivElement | null = null;
  private trackInner: HTMLDivElement | null = null;
  private favoritesBtn: HTMLButtonElement | null = null;
  private thumbRail: HTMLDivElement | null = null;
  private thumbHandle: HTMLDivElement | null = null;
  private tooltip: HTMLDivElement | null = null;
  private hoverToolbar: HTMLDivElement | null = null;

  // ----- Text-pin UI (cluster at bottom of bar) ---------------------------
  // 3-button cluster: prev/next stacked vertically on the LEFT, larger 📌
  // toggle on the RIGHT.  Position: bottom of timeline bar (= bottom-right
  // of screen, since bar lives at the right edge).
  private pinNav: HTMLDivElement | null = null;
  private pinPrevBtn: HTMLButtonElement | null = null;
  private pinNextBtn: HTMLButtonElement | null = null;
  private pinToggleBtn: HTMLButtonElement | null = null;
  // Full-viewport badge layer — holds the visible pin markers floating over
  // the actual message text.  Pointer-events: none on the layer, auto on
  // each badge.
  private pinBadgeLayer: HTMLDivElement | null = null;
  private pinDeleteBtn: HTMLButtonElement | null = null;
  private pinBadges: Map<string, HTMLButtonElement> = new Map();
  // Per-turn pin lists + which pin is currently focused per turn.
  private pinsByTurn: Map<string, TextPin[]> = new Map();
  private activePinByTurn: Map<string, string> = new Map();
  // Pin mode = "next click anywhere creates a pin".  Toggled by the 📌 btn.
  private pinMode = false;
  // The turn that prev/next navigates inside (defaults to active turn but
  // sticks when the user clicks a badge in a different message).
  private pinFocusTurnId: string | null = null;
  // The pin currently shown with a delete button hovering above it.
  private selectedPinId: string | null = null;
  // rAF token for re-positioning all badges.
  private pinBadgeRaf = 0;

  private scrollContainer: HTMLElement | null = null;

  private nodes: Node[] = [];
  private activeIdx = -1;
  private starred: Set<string> = new Set();
  private chatId = '';
  private conversationTitle = '';

  // ----- Active-lock state (fix off-by-one bug after click) ---------------
  /**
   * When set, this is the index the user explicitly clicked. It stays
   * sticky through ANY scroll until the user themselves manually scrolls
   * (wheel / touch / native scrollbar drag). This is the most reliable
   * "click N → highlight N" behaviour: it doesn't depend on timing the
   * smooth-scroll animation, which varies wildly with content height +
   * font-size + browser interruptions.
   */
  private clickedActiveIdx: number | null = null;

  // ----- Drag-thumb state -------------------------------------------------
  private thumbDragging = false;
  private thumbDragStartY = 0;
  private thumbDragStartTop = 0;
  private thumbVisible = false;

  // ----- Lifecycle infra --------------------------------------------------
  private mutationObserver: MutationObserver | null = null;
  private sidebarObserver: MutationObserver | null = null;
  private resyncTimer: number | null = null;
  private chatPollTimer: number | null = null;
  private scrollContainerWatcher: MutationObserver | null = null;
  private nodeRefreshRaf = 0;
  private refreshDebounceTimer = 0;
  // Last rendered ID signature — lets refreshNodes early-exit when the
  // set of user turns hasn't actually changed (streaming text inside an
  // existing wrapper doesn't move any dot).
  private lastRenderedIdSignature = '';
  private hoverToolbarTurnId: string | null = null;

  // Preview panel (the "三条杠" / hamburger drawer) — mirrors
  // GPT-Voyager's `TimelinePreviewPanel`: a 320 px floating list of all
  // turns with search + per-row star toggle + click-to-jump.
  private previewPanel: PreviewPanelHandle | null = null;

  start(): void {
    this.chatId = CHAT_ID_FROM_PATH();
    this.loadPinsForCurrentChat();
    this.conversationTitle = (document.title || '').replace(/\s*-\s*Claude\s*$/i, '').trim();
    this.ensureUI();
    this.ensureHoverToolbar();
    this.ensurePinNav();
    this.ensurePinBadgeLayer();
    this.ensurePreviewPanel();
    void this.refreshStarred();
    this.attachScrollContainer();
    this.attachSidebarObserver();
    this.startChatPoll();
    // Capture-phase click listener so we can intercept the user's next
    // click while pin-mode is on.  Bound here so we can detach in destroy.
    document.addEventListener('click', this.onDocumentPinClick, true);
    window.addEventListener('keydown', this.onDocumentKey, true);
    window.addEventListener('resize', this.schedulePinBadgePositionUpdate);
    // Custom event from the favorites sidebar (or anywhere else):
    // `cv:jump-to-turn` with detail `{ turnId }` scrolls the conversation
    // to that turn, exactly like clicking the matching dot.
    document.addEventListener('cv:jump-to-turn', this.onJumpToTurnEvent as EventListener);
    // Check for a pending cross-conv jump stashed in sessionStorage —
    // this fires when the user clicked a starred-message row in a
    // DIFFERENT conversation; the favorites code wrote the turn id, then
    // navigated us here.  Drain & honour it once nodes have mounted.
    this.consumePendingJump();
  }

  destroy(): void {
    this.previewPanel?.destroy();
    this.previewPanel = null;
    this.root?.remove();
    this.tooltip?.remove();
    this.hoverToolbar?.remove();
    this.root = null;
    this.tooltip = null;
    this.bar = null;
    this.trackInner = null;
    this.favoritesBtn = null;
    this.thumbRail = null;
    this.thumbHandle = null;
    this.hoverToolbar = null;
    this.pinNav?.remove();
    this.pinNav = null;
    this.pinPrevBtn = null;
    this.pinNextBtn = null;
    this.pinToggleBtn = null;
    this.pinBadgeLayer?.remove();
    this.pinBadgeLayer = null;
    this.pinDeleteBtn = null;
    this.pinBadges.clear();
    this.setPinMode(false);
    this.mutationObserver?.disconnect();
    this.sidebarObserver?.disconnect();
    this.scrollContainerWatcher?.disconnect();
    if (this.resyncTimer) window.clearTimeout(this.resyncTimer);
    if (this.chatPollTimer) window.clearInterval(this.chatPollTimer);
    if (this.nodeRefreshRaf) cancelAnimationFrame(this.nodeRefreshRaf);
    if (this.refreshDebounceTimer) window.clearTimeout(this.refreshDebounceTimer);
    if (this.pinBadgeRaf) cancelAnimationFrame(this.pinBadgeRaf);
    this.scrollContainer?.removeEventListener('scroll', this.onScroll);
    document.removeEventListener('mouseover', this.onDocumentMouseOver, true);
    document.removeEventListener('click', this.onDocumentPinClick, true);
    document.removeEventListener('cv:jump-to-turn', this.onJumpToTurnEvent as EventListener);
    window.removeEventListener('keydown', this.onDocumentKey, true);
    window.removeEventListener('pointermove', this.onThumbDrag);
    window.removeEventListener('pointerup', this.onThumbDragEnd);
    window.removeEventListener('resize', this.schedulePinBadgePositionUpdate);
  }

  // ====================================================================
  //  UI BUILDING
  // ====================================================================

  private ensureUI(): void {
    if (this.root) return;
    const root = document.createElement('div');
    root.className = 'cv-tl-root';
    root.style.cssText = [
      'position: fixed',
      'right: 12px',
      'top: 8vh',
      'bottom: 8vh',
      'width: 100px',
      'z-index: 2147483640',
      'pointer-events: none',
      'display: flex',
      'align-items: center',
      'justify-content: flex-end',
    ].join('; ');

    // Drag-thumb rail (positioned LEFT of the bar).
    const thumbRail = document.createElement('div');
    thumbRail.className = 'cv-tl-thumb-rail';
    thumbRail.style.cssText = [
      'position: relative',
      'pointer-events: auto',
      'width: 12px',
      'height: 60%',
      'margin-right: 4px',
      'opacity: 0',
      'transition: opacity 180ms ease-out',
    ].join('; ');
    // Rail line
    const railLine = document.createElement('div');
    railLine.style.cssText = [
      'position: absolute',
      'left: 5px',
      'top: 0',
      'bottom: 0',
      'width: 2px',
      `background: ${PALETTE.rail}`,
      'border-radius: 9999px',
    ].join('; ');
    thumbRail.appendChild(railLine);
    // Handle
    const thumbHandle = document.createElement('div');
    thumbHandle.className = 'cv-tl-thumb';
    thumbHandle.style.cssText = [
      'position: absolute',
      'left: 2px',
      'width: 8px',
      'height: 22px',
      `background: ${PALETTE.thumbIdle}`,
      'border-radius: 9999px',
      'box-shadow: 0 1px 3px rgba(91,50,32,0.2)',
      'cursor: grab',
      'transition: background-color 120ms ease-out',
    ].join('; ');
    thumbHandle.addEventListener('mouseenter', () => {
      thumbHandle.style.background = PALETTE.thumbHover;
    });
    thumbHandle.addEventListener('mouseleave', () => {
      if (!this.thumbDragging) thumbHandle.style.background = PALETTE.thumbIdle;
    });
    thumbHandle.addEventListener('pointerdown', this.onThumbDragStart);
    thumbRail.appendChild(thumbHandle);
    root.appendChild(thumbRail);

    // Main bar — note overflow:visible so pin/star badges that extend
    // beyond the dot edges aren't clipped.  We use a separate scroll
    // wrapper INSIDE the bar that handles overflow for excess dots.
    const bar = document.createElement('div');
    bar.className = 'cv-tl-bar';
    bar.style.cssText = [
      'position: relative',
      'pointer-events: auto',
      'width: 32px',
      'height: 100%',
      `background: ${PALETTE.beigeBar}`,
      'border-radius: 16px',
      'box-shadow: 0 4px 16px rgba(91,50,32,0.16)',
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'padding: 12px 0',
      'backdrop-filter: blur(6px)',
      'overflow: visible',
    ].join('; ');

    // Track wrapper — fills the bar; scrollable when too many dots
    const trackWrap = document.createElement('div');
    trackWrap.className = 'cv-tl-track-wrap';
    trackWrap.style.cssText = [
      'position: relative',
      'flex: 1 1 auto',
      'width: 100%',
      'min-height: 0',
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'overflow-y: auto',
      'overflow-x: hidden',
      'scrollbar-width: none',
      '-ms-overflow-style: none',
    ].join('; ');
    // Hide native scrollbar
    const styleHide = document.createElement('style');
    styleHide.textContent = `.cv-tl-track-wrap::-webkit-scrollbar{display:none}`;
    document.head.appendChild(styleHide);

    const trackInner = document.createElement('div');
    trackInner.className = 'cv-tl-track';
    // 10 px top + bottom padding gives the first / last dot's pin-count
    // badge (positioned at `top: -5px` of the dotWrap) clearance —
    // otherwise trackWrap's `overflow-y: auto` clips half of it.
    trackInner.style.cssText = [
      'position: relative',
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'width: 100%',
      'gap: 6px',
      'padding: 10px 0',
    ].join('; ');
    trackWrap.appendChild(trackInner);

    bar.appendChild(trackWrap);
    root.appendChild(bar);
    document.body.appendChild(root);

    // Hamburger — sits OUTSIDE the bar to the LEFT, vertically centered.
    // Matches GPT-Voyager's pattern of toolbar buttons hugging the bar's
    // outer edge so they never overlap dots.
    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'cv-tl-fav-btn';
    favBtn.title = '收藏对话合集 (Starred messages)';
    favBtn.style.cssText = [
      'position: absolute',
      'right: 44px',          // 32px bar + 4px gap + 8px breathing → outside
      'top: 50%',
      'transform: translateY(-50%)',
      'width: 28px',
      'height: 28px',
      'border-radius: 8px',
      'border: none',
      `background: ${PALETTE.tooltipBg}`,
      `color: ${PALETTE.dotActive}`,
      `box-shadow: 0 2px 8px rgba(91,50,32,0.22), 0 0 0 1px ${PALETTE.tooltipBorder}`,
      'cursor: pointer',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'padding: 5px',
      'z-index: 5',
      'transition: transform 150ms ease-out, background 150ms ease-out',
      'pointer-events: auto',
    ].join('; ');
    favBtn.innerHTML = SVG_HAMBURGER;
    favBtn.addEventListener('mouseenter', () => {
      favBtn.style.transform = 'translateY(-50%) scale(1.08)';
      favBtn.style.background = '#FFFFFF';
    });
    favBtn.addEventListener('mouseleave', () => {
      favBtn.style.transform = 'translateY(-50%)';
      favBtn.style.background = PALETTE.tooltipBg;
    });
    favBtn.addEventListener('click', () => this.previewPanel?.toggle());
    // Append to ROOT (outside bar) so it doesn't overlap with dots.
    root.appendChild(favBtn);

    // Floating tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'cv-tl-tooltip';
    tooltip.style.cssText = [
      'position: fixed',
      'pointer-events: none',
      'opacity: 0',
      'transform: translate(-8px, -50%)',
      'transition: opacity 120ms ease-out, transform 120ms ease-out',
      'max-width: 340px',
      'min-width: 160px',
      'padding: 10px 12px',
      `background: ${PALETTE.tooltipBg}`,
      `color: ${PALETTE.tooltipText}`,
      `border: 1px solid ${PALETTE.tooltipBorder}`,
      'border-radius: 12px',
      'box-shadow: 0 8px 24px rgba(91,50,32,0.22)',
      'font: 500 12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif',
      'z-index: 2147483646',
      'white-space: normal',
      'word-break: break-word',
      'overflow: hidden',
      'display: flex',
      'flex-direction: column',
      'gap: 6px',
    ].join('; ');
    document.body.appendChild(tooltip);

    this.root = root;
    this.bar = bar;
    this.trackInner = trackInner;
    this.favoritesBtn = favBtn;
    this.thumbRail = thumbRail;
    this.thumbHandle = thumbHandle;
    this.tooltip = tooltip;

    // Re-position thumb after the bar lays out
    window.addEventListener('resize', () => this.updateThumb());
    // Listen for inner track scroll to sync thumb position
    trackWrap.addEventListener('scroll', () => this.updateThumb(), { passive: true });
  }

  /**
   * Pin-control cluster — three buttons floating LEFT of the timeline bar,
   * anchored to the bar's BOTTOM (= bottom-right of screen).  Layout
   * mirrors GPT-Voyager: prev (▲) + next (▼) stacked vertically on the
   * left, larger 📌 toggle on the right.  Always visible.
   *
   * Prev/Next navigate between text pins on the CURRENTLY active message.
   * The 📌 toggle flips pin-mode: when enabled, the cursor becomes a
   * crosshair and the next click anywhere inside a message creates a text
   * pin at that exact location.
   */
  private ensurePinNav(): void {
    if (this.pinNav || !this.root) return;
    const wrap = document.createElement('div');
    wrap.className = 'cv-tl-pin-nav';
    wrap.style.cssText = [
      'position: absolute',
      // Sit OUTSIDE the bar on its LEFT side.  Bar width 32 + 8 gap + 8 inset
      'right: 44px',
      // Hug the bar BOTTOM — this is "bottom-right of the screen" because
      // the bar lives at the right edge.  12 px clear of the bar's bottom
      // padding so we don't crowd the edge.
      'bottom: 18px',
      'top: auto',
      'display: flex',
      'flex-direction: row',
      'align-items: center',
      'gap: 4px',
      'pointer-events: auto',
      'z-index: 4',
      'opacity: 0.7',
      'transition: opacity 140ms ease-out, transform 140ms ease-out',
    ].join('; ');
    wrap.addEventListener('mouseenter', () => {
      wrap.style.opacity = '1';
    });
    wrap.addEventListener('mouseleave', () => {
      wrap.style.opacity = this.pinMode ? '1' : '0.7';
    });

    // Stacked prev/next column on the LEFT.
    const stepCol = document.createElement('div');
    stepCol.style.cssText =
      'display:flex; flex-direction:column; gap:2px; align-items:center; justify-content:center;';

    const mkStepBtn = (
      title: string,
      svg: string,
      onClick: () => void,
    ): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.cssText = [
        'width: 18px',
        'height: 15px',
        'border-radius: 6px',
        'border: 1px solid ' + PALETTE.tooltipBorder,
        'padding: 0',
        'cursor: pointer',
        `background: ${PALETTE.tooltipBg}`,
        `color: ${PALETTE.dotIdle}`,
        'box-shadow: 0 2px 6px rgba(91,50,32,0.16)',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'transition: transform 120ms ease-out, background 120ms ease-out, color 120ms ease-out, opacity 120ms ease-out',
      ].join('; ');
      b.innerHTML = svg;
      b.addEventListener('mouseenter', () => {
        if (b.disabled) return;
        b.style.background = PALETTE.dotActive;
        b.style.color = PALETTE.tooltipBg;
        b.style.transform = 'translateY(-1px)';
      });
      b.addEventListener('mouseleave', () => {
        b.style.background = PALETTE.tooltipBg;
        b.style.color = PALETTE.dotIdle;
        b.style.transform = 'translateY(0)';
      });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!b.disabled) onClick();
      });
      return b;
    };

    const SVG_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" width="9" height="9"><path d="M6 14l6-6 6 6"/></svg>`;
    const SVG_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" width="9" height="9"><path d="M6 10l6 6 6-6"/></svg>`;

    this.pinPrevBtn = mkStepBtn('上一个图钉 / Previous pin in message', SVG_UP, () =>
      this.navigateActiveMessagePin(-1),
    );
    this.pinNextBtn = mkStepBtn('下一个图钉 / Next pin in message', SVG_DOWN, () =>
      this.navigateActiveMessagePin(+1),
    );
    stepCol.appendChild(this.pinPrevBtn);
    stepCol.appendChild(this.pinNextBtn);

    // Larger 📌 toggle on the RIGHT.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.title = '开启图钉模式：点击任意消息文本以钉住';
    toggle.setAttribute('aria-label', '开启图钉模式');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.style.cssText = [
      'width: 30px',
      'height: 30px',
      'border-radius: 999px',
      `border: 1px solid ${PALETTE.tooltipBorder}`,
      'padding: 0',
      'cursor: pointer',
      `background: ${PALETTE.tooltipBg}`,
      `color: ${PALETTE.dotActive}`,
      'box-shadow: 0 3px 10px rgba(91,50,32,0.20)',
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'transition: background 140ms ease-out, color 140ms ease-out, transform 140ms ease-out, box-shadow 140ms ease-out',
    ].join('; ');
    toggle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="m14 4 6 6"/><path d="m8 10 6-6 6 6-6 6"/><path d="m9 15-5 5"/><path d="m14 16-6-6"/></svg>`;
    toggle.addEventListener('mouseenter', () => {
      toggle.style.background = PALETTE.dotActive;
      toggle.style.color = PALETTE.tooltipBg;
      toggle.style.transform = 'translateY(-1px) scale(1.04)';
    });
    toggle.addEventListener('mouseleave', () => {
      if (!this.pinMode) {
        toggle.style.background = PALETTE.tooltipBg;
        toggle.style.color = PALETTE.dotActive;
      } else {
        // Stay "active" (filled)
        toggle.style.background = PALETTE.dotActive;
        toggle.style.color = PALETTE.tooltipBg;
      }
      toggle.style.transform = 'translateY(0) scale(1)';
    });
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setPinMode(!this.pinMode);
    });
    this.pinToggleBtn = toggle;

    wrap.appendChild(stepCol);
    wrap.appendChild(toggle);
    this.root.appendChild(wrap);
    this.pinNav = wrap;
    this.updatePinNavState();
  }

  /**
   * Mount the badge layer + delete button that hold the actual text pins
   * (small floating chips overlaid on the message text where the user
   * clicked while in pin-mode).
   */
  private ensurePinBadgeLayer(): void {
    if (this.pinBadgeLayer) return;
    const layer = document.createElement('div');
    layer.className = 'cv-tl-pin-layer';
    layer.style.cssText = [
      'position: fixed',
      'inset: 0',
      'pointer-events: none',
      'z-index: 2147483644',
    ].join('; ');
    document.body.appendChild(layer);
    this.pinBadgeLayer = layer;

    // Delete button hovering above the selected pin badge.
    const del = document.createElement('button');
    del.type = 'button';
    del.title = '删除此图钉';
    del.setAttribute('aria-label', '删除此图钉');
    del.style.cssText = [
      'position: fixed',
      'width: 22px',
      'height: 22px',
      'padding: 0',
      'border-radius: 999px',
      'border: 1px solid rgba(160, 74, 47, 0.8)',
      'background: #C96442',
      'color: #FBF7EF',
      'transform: translate(-50%, -100%) scale(0.92)',
      'box-shadow: 0 8px 20px rgba(91,50,32,0.25)',
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'opacity: 0',
      'pointer-events: none',
      'cursor: pointer',
      'transition: opacity 140ms ease-out, transform 140ms ease-out',
      'z-index: 2147483646',
    ].join('; ');
    del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m6 6 1 14h10l1-14"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>`;
    del.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.deleteSelectedTextPin();
    });
    document.body.appendChild(del);
    this.pinDeleteBtn = del;
  }

  /**
   * Toggle the active-message pin-navigation state: prev/next buttons
   * enabled iff the currently focused message has ≥ 2 pins (or ≥ 1 with
   * room to move).  Toggle button reflects pin-mode state.
   */
  private updatePinNavState(): void {
    if (!this.pinToggleBtn) return;
    // Toggle button visual state
    if (this.pinMode) {
      this.pinToggleBtn.style.background = PALETTE.dotActive;
      this.pinToggleBtn.style.color = PALETTE.tooltipBg;
      this.pinToggleBtn.setAttribute('aria-pressed', 'true');
    } else {
      this.pinToggleBtn.style.background = PALETTE.tooltipBg;
      this.pinToggleBtn.style.color = PALETTE.dotActive;
      this.pinToggleBtn.setAttribute('aria-pressed', 'false');
    }
    // Prev/next buttons: enable when there's at least one pin on the
    // current focus turn AND we're not already at the edge.
    const turnId = this.getCurrentPinTurnId();
    const pins = turnId ? this.pinsByTurn.get(turnId) ?? [] : [];
    const activeIdx = turnId ? this.getActivePinIndexFor(turnId) : -1;
    const prevDisabled = activeIdx <= 0;
    const nextDisabled = activeIdx < 0 || activeIdx >= pins.length - 1;
    if (this.pinPrevBtn) {
      this.pinPrevBtn.disabled = prevDisabled;
      this.pinPrevBtn.style.opacity = prevDisabled ? '0.35' : '1';
      this.pinPrevBtn.style.cursor = prevDisabled ? 'default' : 'pointer';
    }
    if (this.pinNextBtn) {
      this.pinNextBtn.disabled = nextDisabled;
      this.pinNextBtn.style.opacity = nextDisabled ? '0.35' : '1';
      this.pinNextBtn.style.cursor = nextDisabled ? 'default' : 'pointer';
    }
  }

  /**
   * The turn whose pins are currently being navigated.  Prefers the
   * explicitly-focused turn (e.g. user clicked a badge in a different
   * message) but falls back to the active turn.
   */
  private getCurrentPinTurnId(): string | null {
    if (
      this.pinFocusTurnId &&
      this.nodes.some((n) => n.id === this.pinFocusTurnId) &&
      (this.pinsByTurn.get(this.pinFocusTurnId)?.length ?? 0) > 0
    ) {
      return this.pinFocusTurnId;
    }
    const active = this.nodes[this.activeIdx];
    if (!active) return null;
    if ((this.pinsByTurn.get(active.id)?.length ?? 0) > 0) return active.id;
    // Allow prev/next to show a "disabled" state even when active has no pins
    return active.id;
  }

  private getActivePinIndexFor(turnId: string): number {
    const pins = this.pinsByTurn.get(turnId) ?? [];
    if (!pins.length) return -1;
    const currentId = this.activePinByTurn.get(turnId);
    if (!currentId) return 0;
    const i = pins.findIndex((p) => p.id === currentId);
    return i >= 0 ? i : 0;
  }

  /** Mount the table-of-contents preview panel — opened by the hamburger. */
  private ensurePreviewPanel(): void {
    if (this.previewPanel || !this.bar) return;
    this.previewPanel = mountTimelinePreviewPanel({
      anchor: this.bar,
      getRows: (): PreviewRow[] =>
        this.nodes.map((n, i) => ({
          id: n.id,
          index: i,
          text: n.text,
          starred: n.starred,
          attachments: n.attachments.map((a) => ({
            type: a.type,
            label: a.label,
            name: a.name,
          })),
        })),
      getActiveId: () => this.nodes[this.activeIdx]?.id ?? null,
      onNavigate: (row) => this.handleDotClick(row.index, row.id),
      onToggleStar: async (row) => {
        await this.toggleStar(row.id, row.text);
      },
    });
  }

  /** Per-message hover toolbar: star + pin + copy beside the bubble. */
  private ensureHoverToolbar(): void {
    if (this.hoverToolbar) return;
    const tb = document.createElement('div');
    tb.className = 'cv-msg-toolbar';
    tb.style.cssText = [
      'position: absolute',
      'opacity: 0',
      'pointer-events: none',
      'top: -34px',
      'right: 6px',
      'display: inline-flex',
      'gap: 4px',
      'padding: 5px 7px',
      `background: ${PALETTE.tooltipBg}`,
      `border: 1px solid ${PALETTE.tooltipBorder}`,
      'border-radius: 10px',
      'box-shadow: 0 4px 12px rgba(91,50,32,0.18)',
      'z-index: 2147483641',
      'transition: opacity 120ms ease-out',
    ].join('; ');
    this.hoverToolbar = tb;
    document.addEventListener('mouseover', this.onDocumentMouseOver, true);
  }

  private onDocumentMouseOver = (ev: MouseEvent): void => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const userMsg = target.closest('[data-testid="user-message"]') as HTMLElement | null;
    if (!userMsg) return;
    const wrapper = userMsg.closest(MESSAGE_RENDER_WRAPPER_SELECTOR) as HTMLElement | null;
    if (!wrapper) return;
    const node = this.nodes.find((n) => n.wrapper === wrapper);
    if (!node) return;
    this.positionHoverToolbarFor(userMsg, node);
  };

  private positionHoverToolbarFor(userMsg: HTMLElement, node: Node): void {
    if (!this.hoverToolbar) return;
    if (this.hoverToolbarTurnId === node.id && this.hoverToolbar.parentElement) return;
    const bubble = userMsg.closest('[data-user-message-bubble="true"]') as HTMLElement | null;
    const host = bubble || userMsg;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(this.hoverToolbar);
    this.renderHoverToolbar(node);
    this.hoverToolbarTurnId = node.id;
    requestAnimationFrame(() => {
      if (!this.hoverToolbar) return;
      this.hoverToolbar.style.opacity = '1';
      this.hoverToolbar.style.pointerEvents = 'auto';
    });
    const onLeave = () => {
      if (!this.hoverToolbar) return;
      this.hoverToolbar.style.opacity = '0';
      this.hoverToolbar.style.pointerEvents = 'none';
      host.removeEventListener('mouseleave', onLeave);
      this.hoverToolbarTurnId = null;
    };
    host.addEventListener('mouseleave', onLeave);
  }

  private renderHoverToolbar(node: Node): void {
    if (!this.hoverToolbar) return;
    const mkBtn = (
      icon: string,
      label: string,
      active: boolean,
      onClick: () => void,
    ): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = label;
      b.style.cssText = [
        'width: 24px',
        'height: 24px',
        'padding: 4px',
        'border: none',
        'border-radius: 6px',
        'cursor: pointer',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        `color: ${active ? PALETTE.dotActive : PALETTE.dotIdle}`,
        `background: ${active ? PALETTE.starBgTint : 'transparent'}`,
        'transition: background 120ms ease-out, transform 120ms ease-out',
      ].join('; ');
      b.innerHTML = icon;
      b.addEventListener('mouseenter', () => {
        b.style.background = PALETTE.starBgTint;
        b.style.transform = 'scale(1.08)';
      });
      b.addEventListener('mouseleave', () => {
        b.style.background = active ? PALETTE.starBgTint : 'transparent';
        b.style.transform = 'scale(1)';
      });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    };
    this.hoverToolbar.innerHTML = '';
    this.hoverToolbar.appendChild(
      mkBtn(
        node.starred ? SVG_STAR_FILLED : SVG_STAR_OUTLINE,
        '收藏 / 取消收藏',
        node.starred,
        () => this.toggleStar(node.id, node.text),
      ),
    );
  }

  // ====================================================================
  //  DOTS
  // ====================================================================

  private renderDots(): void {
    if (!this.trackInner) return;
    const inner = this.trackInner;
    inner.innerHTML = '';
    if (this.nodes.length === 0) return;

    const tooMany = this.nodes.length > MAX_VISIBLE_DOTS_BEFORE_SCROLL;
    const single = this.nodes.length === 1;

    this.nodes.forEach((node, i) => {
      const row = document.createElement('div');
      row.style.cssText = single
        ? 'display:flex; flex-direction:column; align-items:center; margin:auto 0;'
        : tooMany
        ? 'display:flex; flex-direction:column; align-items:center; flex:0 0 auto; min-height:24px;'
        : 'display:flex; flex-direction:column; align-items:center; flex:1 1 0; min-height:18px;';

      const dotWrap = document.createElement('div');
      dotWrap.style.cssText =
        'position:relative; display:flex; align-items:center; justify-content:center; min-height:16px;';

      const dot = document.createElement('button');
      dot.type = 'button';
      const isActive = i === this.activeIdx;
      const size = isActive ? 16 : 11;
      dot.style.cssText = [
        `width: ${size}px`,
        `height: ${size}px`,
        'border-radius: 50%',
        'border: none',
        'padding: 0',
        'cursor: pointer',
        `background: ${isActive ? PALETTE.dotActive : PALETTE.dotIdle}`,
        `box-shadow: ${isActive ? `0 0 0 3px ${PALETTE.glow}` : 'none'}`,
        'transition: width 150ms ease-out, height 150ms ease-out, background 150ms ease-out, box-shadow 150ms ease-out',
        'position: relative',
      ].join('; ');
      dot.setAttribute('data-cv-turn-id', node.id);
      dot.setAttribute('data-cv-idx', String(i));
      dot.setAttribute('aria-label', `Turn ${i + 1}`);
      dot.addEventListener('click', () => this.handleDotClick(i, node.id));
      dot.addEventListener('mouseenter', (e) => this.showTooltip(e as MouseEvent, node));
      dot.addEventListener('mousemove', (e) => this.moveTooltip(e as MouseEvent));
      dot.addEventListener('mouseleave', () => this.hideTooltip());

      dotWrap.appendChild(dot);

      // --- Star indicator: large gold star overlapping the dot.  Bigger
      // than the dot itself so it reads as a star, not a dot-with-tint.
      if (node.starred) {
        const starBg = document.createElement('span');
        const starSize = isActive ? 22 : 18;
        starBg.style.cssText = [
          'position: absolute',
          'left: 50%',
          'top: 50%',
          `width: ${starSize}px`,
          `height: ${starSize}px`,
          'transform: translate(-50%, -50%)',
          'display: inline-flex',
          'align-items: center',
          'justify-content: center',
          'pointer-events: none',
          `color: ${PALETTE.starGold}`,
          // Two-pass drop shadow: dark warm outline + gold halo.
          `filter: drop-shadow(0 0 1.4px ${PALETTE.starGoldDeep}) drop-shadow(0 0 4px rgba(244, 196, 48, 0.55))`,
          'z-index: 3',
        ].join('; ');
        starBg.innerHTML = SVG_STAR_FILLED;
        dotWrap.appendChild(starBg);
      }

      // --- "Has text pins" indicator: small pin glyph in the dot's top-
      // right when the message contains ≥ 1 text pin.  Visually distinct
      // from the gold star (left-of-dot) and from the actual pin BADGES
      // that float over the message body.
      const pinsHere = this.pinsByTurn.get(node.id)?.length ?? 0;
      if (pinsHere > 0) {
        const pin = document.createElement('span');
        pin.style.cssText = [
          'position: absolute',
          'right: -8px',
          'top: -5px',
          'min-width: 13px',
          'height: 13px',
          'display: inline-flex',
          'align-items: center',
          'justify-content: center',
          'border-radius: 999px',
          `background: ${PALETTE.pinBadgeBg}`,
          `color: ${PALETTE.pinBadgeText}`,
          `box-shadow: 0 2px 8px ${PALETTE.glow}, 0 0 0 1.5px ${PALETTE.tooltipBg}`,
          'pointer-events: none',
          'z-index: 2',
          'padding: 0 3px',
          'font: 700 9px/1 ui-monospace, "SF Mono", Menlo, monospace',
        ].join('; ');
        // Show count if > 1, else just a single pin glyph
        if (pinsHere > 1) {
          pin.textContent = String(pinsHere);
        } else {
          pin.innerHTML = `<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m14 4 6 6"/><path d="m8 10 6-6 6 6-6 6"/><path d="m9 15-5 5"/><path d="m14 16-6-6"/></svg>`;
        }
        dotWrap.appendChild(pin);
      }

      // --- Attachment pills: one short colored bar per attachment, laid
      // out HORIZONTALLY to the left of the dot.  Vertical stacking
      // produced cluttered "ladders" with 2+ files; horizontal row hugs
      // tighter and stays inside the timeline bar's visual lane.  Color
      // comes from the file type so PDFs look different from images,
      // code, csv etc.
      if (node.attachments.length > 0) {
        const stack = document.createElement('span');
        stack.title = node.attachments.map((a) => `${a.label}  ${a.name}`).join('\n');
        const pillCount = Math.min(node.attachments.length, 3);
        // Anchor the RIGHT edge of the strip a few px left of the dot —
        // gives a small breathing gap (4 px) between rightmost pill and
        // the dot itself.
        const dotRadius = Math.ceil((isActive ? 16 : 11) / 2);
        stack.style.cssText = [
          'position: absolute',
          `right: calc(50% + ${dotRadius + 4}px)`,
          'top: 50%',
          'transform: translateY(-50%)',
          'display: inline-flex',
          'flex-direction: row',
          'align-items: center',
          'gap: 2px',
          'pointer-events: none',
        ].join('; ');
        for (const att of node.attachments.slice(0, 3)) {
          const c = TYPE_COLOR[att.type];
          const pill = document.createElement('span');
          pill.style.cssText = [
            'width: 3px',
            'height: 12px',
            `background: ${c.fg}`,
            'border-radius: 999px',
            `box-shadow: 0 0 3px ${c.fg}66`,
            'opacity: 0.92',
          ].join('; ');
          stack.appendChild(pill);
        }
        // Reference pillCount so the lint/TS pass doesn't complain about
        // it being unused now that we're not laying out vertically.
        void pillCount;
        dotWrap.appendChild(stack);
      }

      row.appendChild(dotWrap);

      if (!single && i < this.nodes.length - 1) {
        const line = document.createElement('div');
        line.style.cssText = `width:1.5px; flex:1; min-height:6px; background: ${PALETTE.trackLine}; margin-top:2px;`;
        row.appendChild(line);
      }

      inner.appendChild(row);
    });

    this.updateThumb();
    if (this.activeIdx >= 0) {
      const activeDot = inner.querySelector(`[data-cv-idx="${this.activeIdx}"]`) as HTMLElement | null;
      activeDot?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
    // Keep the preview panel in sync (active row highlight + row list).
    this.previewPanel?.refresh();
    // Recompute prev/next enabled state and re-render text-pin badges so
    // they reflect any new/removed nodes.
    this.updatePinNavState();
    this.renderTextPinBadges();
  }

  // ====================================================================
  //  ACTIVE-INDEX MANAGEMENT (the off-by-one fix)
  // ====================================================================

  /**
   * Click handler — sets active turn IMMEDIATELY (locked), then smooth
   * scrolls. The scroll listener will skip its sync work while
   * `isProgrammaticScrolling` is true, so the active dot doesn't get
   * yanked back to N-1 when scrolling passes through earlier markers.
   */
  private handleDotClick(idx: number, turnId: string): void {
    const node = this.nodes[idx];
    if (!node || !this.scrollContainer) return;

    // Sticky-active: stays N until the user manually scrolls.
    this.clickedActiveIdx = idx;
    this.activeIdx = idx;
    this.renderDots();

    const cRect = this.scrollContainer.getBoundingClientRect();
    const nRect = node.wrapper.getBoundingClientRect();
    const targetTop = nRect.top - cRect.top + this.scrollContainer.scrollTop - SCROLL_OFFSET_PX;
    this.scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  }

  /**
   * Custom-event entry-point for "jump to this turn".  Used by the
   * favorites sidebar (same-conv click).  Treats it like a programmatic
   * dot click — keeps the sticky-active behaviour intact.
   *
   * `content` is the stored text preview from `StarredMessage.content`;
   * used as a fallback resolver when the stored turnId no longer matches
   * a live node (see `resolveTurnIdToIdx`).
   */
  private onJumpToTurnEvent = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ turnId?: string; content?: string }>).detail;
    const turnId = detail?.turnId;
    if (!turnId) return;
    this.jumpToTurn(turnId, detail?.content);
  };

  /**
   * Best-effort jump to the turn with the given id.  Retry loop covers
   * long conversations whose wrappers stream in over a couple of seconds
   * after navigation.  The optional `content` argument lets us still
   * land in the right place even when the stored turnId has drifted —
   * `data-test-render-count` increments across reloads, so stars from a
   * previous session almost always fail an exact id lookup.
   */
  private jumpToTurn(turnId: string, content?: string, retriesLeft = 8): void {
    const idx = this.resolveTurnIdToIdx(turnId, content);
    if (idx >= 0) {
      const node = this.nodes[idx];
      if (node) this.handleDotClick(idx, node.id);
      return;
    }
    if (retriesLeft > 0) {
      window.setTimeout(() => this.jumpToTurn(turnId, content, retriesLeft - 1), 300);
    }
  }

  /**
   * Best-effort turnId → node-index resolution.  Tries (in order):
   *   1. Exact id match — works in the common case (star + jump in the
   *      same browser session, no reload between).
   *   2. Text-content match — works when the user starred the message
   *      in a previous session: the stored `content` preview is matched
   *      against `node.text` (both are the user message body).  This
   *      survives `data-test-render-count` increments and assistant
   *      wrapper insertions / reorderings.
   *   3. Legacy positional heuristic — last resort for stars that have
   *      no content (older builds didn't store it).  Parses the
   *      wrapper-index suffix out of `r<rc>_<wrapperIdx>` and assumes
   *      user messages alternate with assistant messages, so
   *      userIdx ≈ wrapperIdx / 2.
   */
  private resolveTurnIdToIdx(turnId: string, content?: string): number {
    if (!this.nodes.length) return -1;

    // 1. Exact id match (same-session case).
    const direct = this.nodes.findIndex((n) => n.id === turnId);
    if (direct >= 0) return direct;

    // 2. Text-content fallback.
    if (content) {
      const target = content.replace(/\s+/g, ' ').trim();
      if (target) {
        // Compare prefixes — node.text is already MAX_TOOLTIP_CHARS
        // truncated, and StarredMessage.content might be too.  Use the
        // first 32 chars of the (shorter) side for the comparison.
        const limit = Math.min(32, target.length);
        const needle = target.slice(0, limit);
        const idx = this.nodes.findIndex((n) =>
          n.text.replace(/\s+/g, ' ').trim().startsWith(needle),
        );
        if (idx >= 0) return idx;
        // Looser match: substring contains
        const idx2 = this.nodes.findIndex((n) =>
          n.text.replace(/\s+/g, ' ').trim().includes(needle),
        );
        if (idx2 >= 0) return idx2;
      }
    }

    // 3. Legacy positional heuristic — extract trailing number after
    // the last underscore (e.g. r2_40 → 40), divide by 2 assuming
    // user/assistant alternation.  Capped to the live array length.
    const legacy = turnId.match(/_(\d+)$/);
    if (legacy) {
      const wrapperIdx = parseInt(legacy[1], 10);
      if (Number.isFinite(wrapperIdx)) {
        const userIdx = Math.floor(wrapperIdx / 2);
        if (userIdx >= 0 && userIdx < this.nodes.length) return userIdx;
      }
    }

    return -1;
  }

  /**
   * Drain the sessionStorage "pending jump" stash for the current
   * conversation.  Set by the favorites sidebar's cross-conv handler
   * before navigation, consumed once by the destination page.  Retry
   * loop accommodates long conversations whose wrappers stream in over
   * a couple of seconds.
   */
  private consumePendingJump(): void {
    if (!this.chatId) return;
    let raw: string | null = null;
    try {
      const key = `cv-pending-jump:${this.chatId}`;
      raw = sessionStorage.getItem(key);
      if (raw) sessionStorage.removeItem(key);
    } catch {
      return;
    }
    if (!raw) return;
    // Support both old (bare turnId string) and new (JSON-encoded with
    // content) stash formats so the upgrade doesn't strand any
    // in-flight stashes that were written by the previous build.
    let turnId = '';
    let content: string | undefined;
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as { turnId?: string; content?: string };
        turnId = parsed.turnId ?? '';
        content = parsed.content;
      } catch {
        turnId = raw;
      }
    } else {
      turnId = raw;
    }
    if (!turnId) return;
    // Defer until the first refresh produces nodes — jumpToTurn has its
    // own retry loop but giving it a 600 ms head start lets the
    // initial buildNodes complete first.
    window.setTimeout(() => this.jumpToTurn(turnId, content), 600);
  }

  /** Compute active dot from current scroll position. */
  private syncActiveFromScroll(): void {
    if (this.clickedActiveIdx !== null) {
      // Click is sticky — only clear when user does manual scroll.
      if (this.activeIdx !== this.clickedActiveIdx) {
        this.activeIdx = this.clickedActiveIdx;
        this.renderDots();
      }
      return;
    }
    if (!this.nodes.length) return;
    const next = activeIndexFor(this.nodes, this.scrollContainer);
    if (next !== this.activeIdx) {
      this.activeIdx = next;
      this.renderDots();
    }
  }

  /** Called by wheel/touch on the scroll container — drops the click-sticky. */
  private onManualScrollGesture = (): void => {
    if (this.clickedActiveIdx !== null) {
      this.clickedActiveIdx = null;
      // Don't update activeIdx synchronously; the next onScroll will recompute.
    }
  };

  private onScroll = (): void => {
    // Re-position pin badges every frame so they track the message text
    // smoothly as the user scrolls.
    this.schedulePinBadgePositionUpdate();
    if (this.nodeRefreshRaf) return;
    this.nodeRefreshRaf = requestAnimationFrame(() => {
      this.nodeRefreshRaf = 0;
      this.syncActiveFromScroll();
    });
  };

  // ====================================================================
  //  SCROLL THUMB (proportional drag)
  // ====================================================================

  private updateThumb(): void {
    if (!this.thumbRail || !this.thumbHandle || !this.trackInner) return;
    const wrap = this.trackInner.parentElement as HTMLElement | null;
    if (!wrap) return;
    const overflow = wrap.scrollHeight - wrap.clientHeight;
    if (overflow <= 4 || this.nodes.length === 0) {
      this.thumbRail.style.opacity = '0';
      this.thumbVisible = false;
      return;
    }
    this.thumbVisible = true;
    this.thumbRail.style.opacity = '1';

    const railRect = this.thumbRail.getBoundingClientRect();
    const railH = railRect.height;
    // Thumb height proportional to visible/total, clamped to keep it
    // discoverable but never bigger than 40px (user feedback: "scroll bar
    // 太长了给我调短").
    const ratioVisible = wrap.clientHeight / wrap.scrollHeight;
    const handleH = Math.max(20, Math.min(40, railH * ratioVisible));
    const maxTop = Math.max(0, railH - handleH);
    const scrollRatio = wrap.scrollTop / overflow;
    const top = Math.round(scrollRatio * maxTop);
    this.thumbHandle.style.height = `${handleH}px`;
    this.thumbHandle.style.top = `${top}px`;
  }

  private onThumbDragStart = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!this.thumbHandle) return;
    this.thumbDragging = true;
    this.thumbDragStartY = e.clientY;
    this.thumbDragStartTop = parseFloat(this.thumbHandle.style.top) || 0;
    this.thumbHandle.setPointerCapture?.(e.pointerId);
    this.thumbHandle.style.background = PALETTE.thumbHover;
    this.thumbHandle.style.cursor = 'grabbing';
    window.addEventListener('pointermove', this.onThumbDrag);
    window.addEventListener('pointerup', this.onThumbDragEnd);
  };

  private onThumbDrag = (e: PointerEvent): void => {
    if (!this.thumbDragging || !this.thumbRail || !this.thumbHandle || !this.trackInner) return;
    const wrap = this.trackInner.parentElement as HTMLElement | null;
    if (!wrap) return;
    const railH = this.thumbRail.getBoundingClientRect().height;
    const handleH = this.thumbHandle.getBoundingClientRect().height;
    const maxTop = Math.max(1, railH - handleH);
    const delta = e.clientY - this.thumbDragStartY;
    const newTop = Math.max(0, Math.min(maxTop, this.thumbDragStartTop + delta));
    const ratio = newTop / maxTop;
    const overflow = wrap.scrollHeight - wrap.clientHeight;
    wrap.scrollTop = ratio * overflow;
    this.thumbHandle.style.top = `${newTop}px`;
  };

  private onThumbDragEnd = (): void => {
    this.thumbDragging = false;
    if (this.thumbHandle) {
      this.thumbHandle.style.background = PALETTE.thumbIdle;
      this.thumbHandle.style.cursor = 'grab';
    }
    window.removeEventListener('pointermove', this.onThumbDrag);
    window.removeEventListener('pointerup', this.onThumbDragEnd);
  };

  // ====================================================================
  //  NODE DISCOVERY + SYNC
  // ====================================================================

  /**
   * Detect + (re)attach the conversation scroll container.
   *
   * On sidebar-driven conversation switch Claude unmounts the previous
   * `[data-autoscroll-container="true"]` element and mounts a new one;
   * the cached `this.scrollContainer` would then point at a detached
   * node whose `querySelectorAll` returns nothing — that was the root
   * cause of "dots stop updating until I refresh the page".
   *
   * This implementation:
   *   - treats a NEW element (or the cached element becoming detached) as
   *     a re-attach trigger, tearing down old listeners + MutationObserver
   *     and wiring fresh ones,
   *   - keeps the body-level `scrollContainerWatcher` alive for the
   *     entire lifetime of the manager, instead of self-disconnecting on
   *     first find, so subsequent re-mounts are still caught.
   */
  private attachScrollContainer(): void {
    const tryAttach = (): boolean => {
      const el = findScrollContainer();
      if (!el) return false;
      // Already pointing at the live element — nothing to do.
      if (el === this.scrollContainer && el.isConnected) return true;
      // Tear down the previous binding (it may be detached).
      if (this.scrollContainer) {
        this.scrollContainer.removeEventListener('scroll', this.onScroll);
        this.scrollContainer.removeEventListener('wheel', this.onManualScrollGesture);
        this.scrollContainer.removeEventListener('touchstart', this.onManualScrollGesture);
      }
      this.mutationObserver?.disconnect();
      this.scrollContainer = el;
      el.addEventListener('scroll', this.onScroll, { passive: true });
      // wheel/touch on the conversation scroller drops the click-sticky.
      el.addEventListener('wheel', this.onManualScrollGesture, { passive: true });
      el.addEventListener('touchstart', this.onManualScrollGesture, { passive: true });
      // Filter mutations: most are streaming character churn inside an
      // existing wrapper, which can't change the user-turn set.  We only
      // refresh when a wrapper is added/removed.  Defence-in-depth: even
      // if filter passes, refreshNodes has an ID-list early exit.
      this.mutationObserver = new MutationObserver((records) => {
        if (this.shouldIgnoreMutations(records)) return;
        this.scheduleRefresh();
      });
      this.mutationObserver.observe(el, { childList: true, subtree: true });
      this.refreshNodes();
      return true;
    };
    tryAttach();
    // Persistent body-level watcher: keeps running for the manager's
    // lifetime so we can re-attach if Claude unmounts/replaces the
    // scroll container during a sidebar navigation.
    if (this.scrollContainerWatcher) return;
    this.scrollContainerWatcher = new MutationObserver(() => {
      // If the cached scrollContainer was removed from the DOM, drop it
      // first so tryAttach's identity check fires.
      if (this.scrollContainer && !this.scrollContainer.isConnected) {
        this.scrollContainer = null;
      }
      tryAttach();
    });
    this.scrollContainerWatcher.observe(document.body, { childList: true, subtree: true });
  }

  private attachSidebarObserver(): void {
    const sb = findSidebar();
    if (!sb) return;
    this.sidebarObserver = new MutationObserver((mutations) => {
      const has = mutations.some(
        (m) =>
          Array.from(m.addedNodes).some(
            (n) =>
              n instanceof HTMLElement &&
              (n.matches(CONVERSATION_LINK_SELECTOR) ||
                n.querySelector(CONVERSATION_LINK_SELECTOR)),
          ) ||
          Array.from(m.removedNodes).some(
            (n) =>
              n instanceof HTMLElement &&
              (n.matches(CONVERSATION_LINK_SELECTOR) ||
                n.querySelector(CONVERSATION_LINK_SELECTOR)),
          ),
      );
      if (!has) return;
      if (this.resyncTimer) window.clearTimeout(this.resyncTimer);
      this.resyncTimer = window.setTimeout(() => this.refreshNodes(), SIDEBAR_RESYNC_DEBOUNCE_MS);
    });
    this.sidebarObserver.observe(sb, { childList: true, subtree: true });
  }

  private startChatPoll(): void {
    this.chatPollTimer = window.setInterval(() => {
      const newId = CHAT_ID_FROM_PATH();
      if (newId === this.chatId) return;
      this.chatId = newId;
      this.loadPinsForCurrentChat();
      this.conversationTitle = (document.title || '').replace(/\s*-\s*Claude\s*$/i, '').trim();
      void this.refreshStarred();
      // Clear any pin badges left from the previous conversation.
      for (const [, badge] of this.pinBadges) badge.remove();
      this.pinBadges.clear();
      this.setPinMode(false);
      this.clickedActiveIdx = null;     // drop any sticky click from prev conv
      this.nodes = [];
      this.activeIdx = 0;
      // Force the next refreshNodes to actually re-render (different
      // conv = different ID space).
      this.lastRenderedIdSignature = '';
      this.renderDots();
      // Re-detect the scroll container — when the user clicks a sidebar
      // entry, Claude unmounts the previous `[data-autoscroll-container]`
      // and mounts a fresh one.  Without this re-attach our cached
      // reference goes stale and `buildNodes` queries an orphaned element.
      this.attachScrollContainer();
      if (this.resyncTimer) window.clearTimeout(this.resyncTimer);
      // Also poll a few times after the initial delay — Claude streams
      // wrappers in over ~1-2 s for long conversations, so a single
      // refresh at T+800 ms can miss them all.  The MutationObserver
      // catches most cases, but for very-fast hops the polling fallback
      // helps confirm we don't end up stuck with an empty timeline.
      this.resyncTimer = window.setTimeout(() => {
        this.refreshNodes();
        // Second-pass refresh after another beat — for long conversations
        // whose wrappers are still mounting at T+800 ms.
        window.setTimeout(() => this.refreshNodes(), 1200);
      }, CHAT_RESYNC_DELAY_MS);
    }, CHAT_POLL_INTERVAL_MS);
  }

  private async refreshStarred(): Promise<void> {
    try {
      const list = await StarredMessagesService.getStarredMessagesForConversation(this.chatId);
      this.starred = new Set(list.map((m) => m.turnId));
      this.renderDots();
    } catch {
      /* offline */
    }
  }

  /**
   * Coalesce mutation events from the conversation scroll container.
   *
   * Robustness lessons borrowed from GPT-Voyager's
   * `timeline/manager.ts#recalculateAndRenderMarkers`:
   *
   *  - A streaming assistant response can fire 50–100 MutationObserver
   *    callbacks per second.  Most of them flip text inside an existing
   *    `[data-test-render-count]` wrapper and do NOT change the set of
   *    user turns we render dots for.  So we coalesce to a single
   *    refresh attempt per ~120 ms (instead of per animation frame).
   *
   *  - Below that timeout we still ID-compare in `refreshNodes` to skip
   *    re-rendering when nothing actually moved.  Defence in depth.
   */
  private scheduleRefresh(): void {
    if (this.refreshDebounceTimer) return;
    this.refreshDebounceTimer = window.setTimeout(() => {
      this.refreshDebounceTimer = 0;
      this.refreshNodes();
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * Filter mutation records so we only trigger refresh work for changes
   * that could plausibly add/remove a USER turn.  Streaming text inside
   * an existing assistant wrapper just churns characterData / inner
   * `<span>` text, none of which can change the user-turn list.
   *
   * Returns true when we should ignore this batch entirely.
   */
  private shouldIgnoreMutations(records: MutationRecord[]): boolean {
    for (const rec of records) {
      if (rec.type === 'childList') {
        // A childList change inside an EXISTING wrapper still can't
        // create a new user turn; only changes that add/remove a
        // `[data-test-render-count]` wrapper matter.  Cheap check: if
        // ANY added or removed node is (or contains) such a wrapper,
        // the batch is interesting.
        for (const n of rec.addedNodes) {
          if (n instanceof Element && this.isUserTurnRelevant(n)) return false;
        }
        for (const n of rec.removedNodes) {
          if (n instanceof Element && this.isUserTurnRelevant(n)) return false;
        }
        continue;
      }
      // attributes / characterData mutations are never relevant —
      // we don't observe them, but stay defensive.
    }
    return true;
  }

  /** Returns true if the element is, or contains, a user-turn wrapper. */
  private isUserTurnRelevant(el: Element): boolean {
    if (el.matches?.(MESSAGE_RENDER_WRAPPER_SELECTOR)) return true;
    if (el.querySelector?.(MESSAGE_RENDER_WRAPPER_SELECTOR)) return true;
    // The user-message bubble itself, in case Claude unmounts inner
    // pieces during edit-and-resubmit before re-mounting the wrapper.
    if (el.matches?.(USER_MESSAGE_SELECTOR)) return true;
    if (el.querySelector?.(USER_MESSAGE_SELECTOR)) return true;
    return false;
  }

  /**
   * Discover user-turn wrappers in DOM order.
   *
   * Two signals each wrapper can carry — we accept either:
   *
   *   1. `[data-testid="user-message"]` — present for any turn that has
   *      typed text in the bubble (the common case).
   *
   *   2. Attachment markers (`[data-testid="file-thumbnail"]` or a
   *      `[data-testid]` whose value looks like `filename.ext`).  These
   *      appear in pure-attachment turns where the user uploaded files
   *      without typing anything — Claude renders no `user-message`
   *      bubble in that case, and the old check skipped these wrappers,
   *      leaving them invisible in the timeline.
   *
   * Assistant wrappers are excluded via the `.font-claude-response` /
   * `[data-is-streaming]` markers — same pattern claude-nexus uses.
   */
  private buildNodes(): Node[] {
    if (!this.scrollContainer) return [];
    const wrappers = Array.from(
      this.scrollContainer.querySelectorAll(MESSAGE_RENDER_WRAPPER_SELECTOR),
    );
    const out: Node[] = [];
    for (const [i, wrapper] of wrappers.entries()) {
      // Reject assistant turns first
      if (
        wrapper.querySelector('.font-claude-response') ||
        wrapper.querySelector('[data-is-streaming]')
      ) {
        continue;
      }
      const hasUserMessage = !!wrapper.querySelector(USER_MESSAGE_SELECTOR);
      // Cheap attachment probe — only check for the two markers we render
      // chips for.  Saves running detectAttachments twice when the
      // wrapper has no attachments either.
      const hasAttachments =
        !!wrapper.querySelector('[data-testid="file-thumbnail"]') ||
        Array.from(wrapper.querySelectorAll<HTMLElement>('[data-testid]')).some((el) => {
          const tid = el.getAttribute('data-testid') || '';
          return /\.(pdf|png|jpe?g|gif|webp|svg|md|csv|json|docx?|pptx?|xlsx?|mp[34]|wav|m4a|mov|avi|mkv|webm|zip|txt)$/i.test(tid);
        });
      if (!hasUserMessage && !hasAttachments) continue;
      const rc = wrapper.getAttribute('data-test-render-count') || '';
      const id = rc ? `r${rc}_${i}` : `i${i}`;
      const attachments = detectAttachments(wrapper);
      // For a pure-attachment turn (no text), fall back to a label
      // synthesised from the attachment names so the tooltip / preview
      // panel doesn't render an empty row.
      let text = hasUserMessage ? extractUserText(wrapper) : '';
      if (!text && attachments.length > 0) {
        const names = attachments.map((a) => a.name).slice(0, 3).join(' · ');
        text = `📎 ${names}`;
      }
      out.push({
        id,
        wrapper,
        text,
        starred: this.starred.has(id),
        attachments,
      });
    }
    return out;
  }

  /**
   * Rebuild the live `nodes` array from the DOM and re-render dots.
   *
   * Robustness shortcut: if the set of user-turn IDs hasn't changed
   * (same IDs in the same order), we still need to update text snippets
   * (e.g. a streaming user message gets finalised) but we can skip the
   * dot DOM rebuild.  `renderDots` itself takes care of reusing existing
   * dot DOM elements by ID — that's the second line of defence against
   * thrashing during streaming.
   */
  private refreshNodes(): void {
    if (!this.scrollContainer) return;
    const nextNodes = this.buildNodes();
    const nextSignature = nextNodes.map((n) => n.id).join('|');
    const idsUnchanged = nextSignature === this.lastRenderedIdSignature;
    this.nodes = nextNodes;
    if (this.clickedActiveIdx !== null) {
      // Preserve click-sticky across resyncs (e.g. new messages streaming in).
      this.activeIdx = Math.min(this.clickedActiveIdx, this.nodes.length - 1);
    } else {
      this.activeIdx = activeIndexFor(this.nodes, this.scrollContainer);
    }
    // When IDs are unchanged AND active index is unchanged AND no
    // pin/star state has shifted, skip the dot render entirely — saves
    // ~60 renderDots() calls/sec during a streaming assistant turn.
    // We still want pin-nav state to be in sync.
    if (idsUnchanged) {
      this.updatePinNavState();
      this.schedulePinBadgePositionUpdate();
      return;
    }
    this.lastRenderedIdSignature = nextSignature;
    this.renderDots();
  }

  // ====================================================================
  //  TEXT PINS — lifecycle
  // ====================================================================

  /**
   * Read all text pins for the current conversation from localStorage and
   * rebuild the in-memory state maps.  Called on startup and whenever the
   * URL chat id changes.
   */
  private loadPinsForCurrentChat(): void {
    this.pinsByTurn.clear();
    this.activePinByTurn.clear();
    this.pinFocusTurnId = null;
    this.selectedPinId = null;
    const pins = loadTextPins(this.chatId);
    for (const pin of pins) {
      const list = this.pinsByTurn.get(pin.turnId) ?? [];
      list.push(pin);
      this.pinsByTurn.set(pin.turnId, list);
    }
    for (const [turnId, list] of this.pinsByTurn) {
      list.sort((a, b) => a.yOffset - b.yOffset);
      this.activePinByTurn.set(turnId, list[0].id);
    }
  }

  private persistPins(): void {
    const all = Array.from(this.pinsByTurn.values()).flat();
    saveTextPins(this.chatId, all);
  }

  /** Toggle pin-mode.  When ON, body cursor becomes crosshair. */
  private setPinMode(enabled: boolean): void {
    this.pinMode = enabled;
    document.body.classList.toggle('cv-pin-picking', enabled);
    if (enabled) {
      document.body.style.cursor = 'crosshair';
    } else {
      document.body.style.cursor = '';
    }
    if (this.pinNav) {
      this.pinNav.style.opacity = enabled ? '1' : '0.7';
    }
    this.updatePinNavState();
  }

  /**
   * Capture-phase click handler.  When pin-mode is on and the click target
   * is inside a real message turn, create a pin and exit pin-mode.
   *
   * Returns silently for clicks on our own UI (the cluster, the bar,
   * preview panel, etc.) — those should still operate normally.
   */
  private onDocumentPinClick = (ev: MouseEvent): void => {
    if (!this.pinMode) return;
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    // Ignore clicks on our own UI
    if (
      target.closest(
        '.cv-tl-root, .cv-tl-bar, .cv-tl-pin-nav, .cv-tl-pin-layer, .cv-tl-fav-btn, .cv-tl-tooltip, .cv-tl-preview-panel, .cv-msg-toolbar',
      )
    ) {
      return;
    }
    const pinTarget = this.resolveTextPinTarget(target, ev.clientX, ev.clientY);
    if (!pinTarget) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.addTextPin(pinTarget, ev.clientX, ev.clientY, target);
    this.setPinMode(false);
  };

  private onDocumentKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && this.pinMode) {
      this.setPinMode(false);
    }
  };

  /**
   * Given a click target + viewport coords, find which message turn the
   * click landed in (if any) and return the relative xOffset/yOffset
   * within that turn's wrapper.  Falls back to "nearest preceding turn"
   * for clicks on assistant text that lives between two user turns —
   * those are attributed to the user turn that started the exchange.
   */
  private resolveTextPinTarget(
    target: HTMLElement,
    clientX: number,
    clientY: number,
  ): TextPinTarget | null {
    if (!this.scrollContainer || this.nodes.length === 0) return null;

    // First try: target is inside a known user-message wrapper
    const direct = this.nodes.find((n) => n.wrapper.contains(target));
    if (direct) {
      const rect = (direct.wrapper as HTMLElement).getBoundingClientRect();
      const y = Math.max(0, clientY - rect.top);
      return {
        marker: { id: direct.id, element: direct.wrapper as HTMLElement },
        xOffset: Math.max(0, clientX - rect.left),
        xRatio: clamp01((clientX - rect.left) / Math.max(1, rect.width)),
        yOffset: y,
      };
    }

    // Outside any direct wrapper — attribute to nearest preceding user turn.
    // Click must still be inside the scroll container.
    if (!this.scrollContainer.contains(target)) return null;

    const scrollRect = this.scrollContainer.getBoundingClientRect();
    const clickTop = clientY - scrollRect.top + this.scrollContainer.scrollTop;
    let ownerIdx = -1;
    let ownerRect: DOMRect | null = null;
    let ownerTop = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const wrapper = this.nodes[i].wrapper as HTMLElement;
      const r = wrapper.getBoundingClientRect();
      const top = r.top - scrollRect.top + this.scrollContainer.scrollTop;
      if (top <= clickTop) {
        ownerIdx = i;
        ownerRect = r;
        ownerTop = top;
      } else {
        break;
      }
    }
    if (ownerIdx < 0 || !ownerRect) return null;
    const owner = this.nodes[ownerIdx];
    const yOffset = Math.max(0, clickTop - ownerTop);
    return {
      marker: { id: owner.id, element: owner.wrapper as HTMLElement },
      xOffset: Math.max(0, clientX - ownerRect.left),
      xRatio: clamp01((clientX - ownerRect.left) / Math.max(1, ownerRect.width)),
      yOffset,
    };
  }

  /** Create a pin from a resolved target + persist + render. */
  private addTextPin(
    t: TextPinTarget,
    clientX: number,
    clientY: number,
    target: HTMLElement,
  ): void {
    const rect = t.marker.element.getBoundingClientRect();
    const yOffset = t.yOffset;
    const pin: TextPin = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      turnId: t.marker.id,
      xOffset: t.xOffset,
      xRatio: t.xRatio,
      yOffset,
      yRatio: clamp01(yOffset / Math.max(1, rect.height)),
      text: extractTextAroundPoint(clientX, clientY, target),
      createdAt: Date.now(),
    };
    const list = this.pinsByTurn.get(pin.turnId) ?? [];
    list.push(pin);
    list.sort((a, b) => a.yOffset - b.yOffset);
    this.pinsByTurn.set(pin.turnId, list);
    this.activePinByTurn.set(pin.turnId, pin.id);
    this.pinFocusTurnId = pin.turnId;
    this.persistPins();
    this.renderDots();           // updates "has-pins" dot indicator
    this.renderTextPinBadges();
    this.updatePinNavState();
  }

  /** Render / refresh the floating pin badges over message text. */
  private renderTextPinBadges(): void {
    if (!this.pinBadgeLayer) return;
    const live = new Set<string>();
    for (const node of this.nodes) {
      const pins = this.pinsByTurn.get(node.id) ?? [];
      for (const pin of pins) {
        live.add(pin.id);
        let badge = this.pinBadges.get(pin.id);
        if (!badge) {
          badge = document.createElement('button');
          badge.type = 'button';
          badge.className = 'cv-tl-pin-badge';
          badge.dataset.pinId = pin.id;
          badge.dataset.turnId = pin.turnId;
          badge.title = pin.text ? `图钉：${pin.text}` : '图钉';
          badge.setAttribute('aria-label', pin.text || '图钉');
          badge.style.cssText = [
            'position: fixed',
            'width: 22px',
            'height: 22px',
            'padding: 0',
            'border: 1px solid rgba(160, 74, 47, 0.85)',
            'border-radius: 999px',
            'background: rgba(201, 100, 66, 0.96)',
            'color: #FBF7EF',
            'transform: translate(-50%, -100%)',
            'box-shadow: 0 8px 20px rgba(91,50,32,0.30), 0 0 0 2px rgba(255,255,255,0.32)',
            'display: inline-flex',
            'align-items: center',
            'justify-content: center',
            'pointer-events: auto',
            'cursor: pointer',
            'transition: transform 140ms ease-out, box-shadow 140ms ease-out, opacity 140ms ease-out',
            'z-index: 2147483645',
          ].join('; ');
          badge.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m14 4 6 6"/><path d="m8 10 6-6 6 6-6 6"/><path d="m9 15-5 5"/><path d="m14 16-6-6"/></svg>`;
          badge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.selectTextPin(pin, true);
          });
          this.pinBadgeLayer.appendChild(badge);
          this.pinBadges.set(pin.id, badge);
        }
        const isActive = this.activePinByTurn.get(pin.turnId) === pin.id;
        const isSelected = this.selectedPinId === pin.id;
        badge.style.boxShadow = isSelected
          ? '0 12px 28px rgba(201, 100, 66, 0.50), 0 0 0 4px rgba(232, 168, 124, 0.6)'
          : isActive
          ? '0 10px 24px rgba(201, 100, 66, 0.42), 0 0 0 3px rgba(232, 168, 124, 0.5)'
          : '0 8px 20px rgba(91,50,32,0.30), 0 0 0 2px rgba(255,255,255,0.32)';
      }
    }
    // GC removed pins
    for (const [id, badge] of this.pinBadges) {
      if (!live.has(id)) {
        badge.remove();
        this.pinBadges.delete(id);
      }
    }
    this.schedulePinBadgePositionUpdate();
  }

  private schedulePinBadgePositionUpdate = (): void => {
    if (this.pinBadgeRaf) return;
    this.pinBadgeRaf = requestAnimationFrame(() => {
      this.pinBadgeRaf = 0;
      this.positionTextPinBadges();
    });
  };

  /**
   * Position each badge over its anchor text using current viewport
   * coordinates.  Badges that fall outside the viewport get visually
   * collapsed (opacity 0) without being removed.
   */
  private positionTextPinBadges(): void {
    if (!this.pinBadgeLayer) return;
    for (const node of this.nodes) {
      const pins = this.pinsByTurn.get(node.id) ?? [];
      if (!pins.length) continue;
      const wrapperEl = node.wrapper as HTMLElement;
      const rect = wrapperEl.getBoundingClientRect();
      // Find a stable horizontal base — the user-message bubble if it
      // exists, otherwise the wrapper rect.  Bubble keeps x stable when
      // the user resizes the viewport.
      const bubble = wrapperEl.querySelector(
        '[data-user-message-bubble="true"]',
      ) as HTMLElement | null;
      const baseRect = bubble?.getBoundingClientRect() ?? rect;
      for (const pin of pins) {
        const badge = this.pinBadges.get(pin.id);
        if (!badge) continue;
        const yOffset = Math.max(
          0,
          pin.yOffset || pin.yRatio * (rect.height || 1),
        );
        const y = rect.top + yOffset;
        // Visibility check — keep badge mounted but transparent if anchor
        // is offscreen.  Otherwise the badge "follows" the user as they
        // scroll without flicker.
        const visible = wrapperEl.isConnected && y >= -40 && y <= window.innerHeight + 40;
        if (!visible) {
          badge.style.opacity = '0';
          badge.style.pointerEvents = 'none';
          continue;
        }
        const x = baseRect.left + Math.min(baseRect.width, pin.xOffset || baseRect.width * pin.xRatio);
        badge.style.left = `${Math.round(x)}px`;
        badge.style.top = `${Math.round(y)}px`;
        badge.style.opacity = '1';
        badge.style.pointerEvents = 'auto';
      }
    }
    this.positionPinDeleteButton();
  }

  private positionPinDeleteButton(): void {
    if (!this.pinDeleteBtn) return;
    if (!this.selectedPinId) {
      this.pinDeleteBtn.style.opacity = '0';
      this.pinDeleteBtn.style.pointerEvents = 'none';
      return;
    }
    const badge = this.pinBadges.get(this.selectedPinId);
    if (!badge || badge.style.opacity === '0' || !badge.isConnected) {
      this.pinDeleteBtn.style.opacity = '0';
      this.pinDeleteBtn.style.pointerEvents = 'none';
      return;
    }
    const r = badge.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      this.pinDeleteBtn.style.opacity = '0';
      this.pinDeleteBtn.style.pointerEvents = 'none';
      return;
    }
    this.pinDeleteBtn.style.left = `${Math.round(r.left + r.width / 2)}px`;
    this.pinDeleteBtn.style.top = `${Math.round(r.top - 4)}px`;
    this.pinDeleteBtn.style.opacity = '1';
    this.pinDeleteBtn.style.pointerEvents = 'auto';
    this.pinDeleteBtn.style.transform = 'translate(-50%, -100%) scale(1)';
  }

  /** Click handler for a badge — selects + shows delete button. */
  private selectTextPin(pin: TextPin, showDelete: boolean): void {
    this.activePinByTurn.set(pin.turnId, pin.id);
    this.pinFocusTurnId = pin.turnId;
    this.selectedPinId = showDelete ? pin.id : null;
    // Move active timeline highlight to the owning turn for visual
    // continuity.
    const idx = this.nodes.findIndex((n) => n.id === pin.turnId);
    if (idx >= 0) {
      this.clickedActiveIdx = idx;
      this.activeIdx = idx;
    }
    this.renderTextPinBadges();
    this.updatePinNavState();
    this.renderDots();
    this.navigateToTextPin(pin);
  }

  private deleteSelectedTextPin(): void {
    if (!this.selectedPinId) return;
    const pinId = this.selectedPinId;
    // Find owning turn
    let turnId: string | null = null;
    for (const [tid, list] of this.pinsByTurn) {
      if (list.some((p) => p.id === pinId)) {
        turnId = tid;
        break;
      }
    }
    if (!turnId) return;
    const list = this.pinsByTurn.get(turnId) ?? [];
    const removedIdx = Math.max(0, list.findIndex((p) => p.id === pinId));
    const next = list.filter((p) => p.id !== pinId);
    if (next.length) {
      this.pinsByTurn.set(turnId, next);
      if (this.activePinByTurn.get(turnId) === pinId) {
        this.activePinByTurn.set(
          turnId,
          next[Math.min(removedIdx, next.length - 1)].id,
        );
      }
    } else {
      this.pinsByTurn.delete(turnId);
      this.activePinByTurn.delete(turnId);
      if (this.pinFocusTurnId === turnId) this.pinFocusTurnId = null;
    }
    this.selectedPinId = null;
    this.pinBadges.get(pinId)?.remove();
    this.pinBadges.delete(pinId);
    this.persistPins();
    this.renderDots();
    this.renderTextPinBadges();
    this.updatePinNavState();
  }

  /**
   * Step prev/next through pins on the currently focused message and
   * smooth-scroll to land the selected pin in the viewport.
   */
  private navigateActiveMessagePin(direction: -1 | 1): void {
    const turnId = this.getCurrentPinTurnId();
    if (!turnId) return;
    const pins = this.pinsByTurn.get(turnId) ?? [];
    if (!pins.length) return;
    const idx = this.getActivePinIndexFor(turnId);
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= pins.length) {
      this.updatePinNavState();
      return;
    }
    const pin = pins[nextIdx];
    this.selectTextPin(pin, false);
  }

  /** Scroll the conversation container so the pin sits in the upper third. */
  private navigateToTextPin(pin: TextPin): void {
    const node = this.nodes.find((n) => n.id === pin.turnId);
    if (!node || !this.scrollContainer) return;
    const wrapper = node.wrapper as HTMLElement;
    const cRect = this.scrollContainer.getBoundingClientRect();
    const wRect = wrapper.getBoundingClientRect();
    const wrapperScrollTop =
      wRect.top - cRect.top + this.scrollContainer.scrollTop;
    const target = wrapperScrollTop + pin.yOffset - Math.round(this.scrollContainer.clientHeight * 0.22);
    this.scrollContainer.scrollTo({
      top: Math.max(0, target),
      behavior: 'smooth',
    });
  }

  // ====================================================================
  //  PUBLIC ACTIONS
  // ====================================================================

  async toggleStar(turnId: string, text: string): Promise<void> {
    try {
      if (this.starred.has(turnId)) {
        await StarredMessagesService.removeStarredMessage(this.chatId, turnId);
        this.starred.delete(turnId);
      } else {
        const msg: StarredMessage = {
          turnId,
          conversationId: this.chatId,
          conversationUrl: location.href,
          conversationTitle: this.conversationTitle || (document.title || '').trim(),
          content: text,
          starredAt: Date.now(),
        };
        await StarredMessagesService.addStarredMessage(msg);
        this.starred.add(turnId);
      }
      this.nodes = this.nodes.map((n) => ({ ...n, starred: this.starred.has(n.id) }));
      this.renderDots();
      const n = this.nodes.find((x) => x.id === turnId);
      if (n && this.hoverToolbarTurnId === turnId) this.renderHoverToolbar(n);
    } catch (err) {
      console.warn('[Claude-Voyager] toggleStar failed', err);
    }
  }

  // ====================================================================
  //  TOOLTIP
  // ====================================================================

  private showTooltip(ev: MouseEvent, node: Node): void {
    if (!this.tooltip) return;
    this.tooltip.innerHTML = '';
    // Text body (clamped to 4 lines)
    const body = document.createElement('div');
    body.style.cssText = [
      'display: -webkit-box',
      '-webkit-line-clamp: 4',
      '-webkit-box-orient: vertical',
      'overflow: hidden',
      'word-break: break-word',
    ].join('; ');
    body.textContent = node.text || '(无预览)';
    this.tooltip.appendChild(body);
    // Attachment chips — colored rounded rect per file type
    if (node.attachments.length > 0) {
      const chips = document.createElement('div');
      chips.style.cssText = [
        'display: flex',
        'flex-wrap: wrap',
        'gap: 4px',
        'padding-top: 4px',
        'border-top: 1px dashed rgba(91,50,32,0.16)',
      ].join('; ');
      for (const att of node.attachments.slice(0, 6)) {
        const c = TYPE_COLOR[att.type];
        const chip = document.createElement('span');
        chip.style.cssText = [
          'display: inline-flex',
          'align-items: center',
          'gap: 4px',
          'padding: 2px 7px 3px',
          'border-radius: 6px',
          'font: 600 10.5px/1.4 ui-monospace, "SF Mono", Menlo, monospace',
          `color: ${c.fg}`,
          `background: ${c.bg}`,
          `border: 1px solid ${c.border}`,
          'max-width: 200px',
        ].join('; ');
        const lab = document.createElement('span');
        lab.textContent = att.label;
        lab.style.cssText = 'font-weight: 700; letter-spacing: 0.03em;';
        const sep = document.createElement('span');
        sep.textContent = '·';
        sep.style.cssText = 'opacity: 0.5;';
        const nm = document.createElement('span');
        nm.textContent = att.name;
        nm.style.cssText = 'font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px;';
        chip.appendChild(lab);
        chip.appendChild(sep);
        chip.appendChild(nm);
        chips.appendChild(chip);
      }
      this.tooltip.appendChild(chips);
    }
    this.tooltip.style.opacity = '1';
    this.tooltip.style.transform = 'translate(-8px, -50%)';
    this.moveTooltip(ev);
  }
  private moveTooltip(ev: MouseEvent): void {
    if (!this.tooltip) return;
    const left = Math.max(8, ev.clientX - this.tooltip.offsetWidth - 16);
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${ev.clientY}px`;
  }
  private hideTooltip(): void {
    if (!this.tooltip) return;
    this.tooltip.style.opacity = '0';
    this.tooltip.style.transform = 'translate(-2px, -50%)';
  }
}

/**
 * Resolve which node is "active" given the current scroll position.
 *
 * Bug-fix:  claude-nexus uses `wrapper.top < SCROLL_OFFSET_PX` which is a
 * VIEWPORT-relative comparison.  But on Claude the scroll container itself
 * starts ~50 px below the viewport top (the header).  After we smooth-scroll
 * so that the target wrapper sits exactly SCROLL_OFFSET_PX *below the
 * container's top*, that wrapper's VIEWPORT top is `containerTop +
 * SCROLL_OFFSET_PX` which is well past the threshold — making
 * `activeIndexFor` return the PREVIOUS dot.  Off-by-one (or -two).
 *
 * The right comparison is **container-relative**: subtract the container's
 * viewport top first.  Add 4 px tolerance for sub-pixel rounding of the
 * smooth-scroll landing position.
 */
function activeIndexFor(nodes: Node[], scrollContainer: HTMLElement | null): number {
  if (!nodes.length) return -1;
  const cTop = scrollContainer?.getBoundingClientRect().top ?? 0;
  const threshold = SCROLL_OFFSET_PX + 4;
  let active = -1;
  for (let i = 0; i < nodes.length; i++) {
    const containerRelTop = nodes[i].wrapper.getBoundingClientRect().top - cTop;
    if (containerRelTop < threshold) active = i;
  }
  return Math.max(0, active);
}

// ====================================================================
//  Singleton bootstrap + favorites drawer
// ====================================================================

let instance: TimelineV2 | null = null;

export function startTimelineV2(): void {
  if (instance) return;
  if (!document.body) {
    const obs = new MutationObserver(() => {
      if (!document.body) return;
      obs.disconnect();
      startTimelineV2();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  instance = new TimelineV2();
  instance.start();
}

export function destroyTimelineV2(): void {
  instance?.destroy();
  instance = null;
}

// (The favorites-drawer code was removed.  The hamburger now opens the
// table-of-contents `TimelinePreviewPanel` instead — see `ensurePreviewPanel`
// in the TimelineV2 class.)
