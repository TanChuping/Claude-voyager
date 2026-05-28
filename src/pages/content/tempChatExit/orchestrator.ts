/**
 * Incognito chat hand-off ("temp chat regret") for Claude.ai.
 *
 * High-level flow:
 *   1. User confirms via modal.
 *   2. Loading overlay covers the page.  We scroll the conversation
 *      container to the top (gives any virtualized older turns a chance
 *      to mount), then DOM-extract user/assistant turns in order.
 *   3. We stash the rendered hand-off payload to `sessionStorage` and
 *      click Claude's own "Exit incognito" button.  Claude routes
 *      client-side to a fresh persistent chat — our content script
 *      stays alive across the route change.
 *   4. After the route settles, we paste the directive (+ optional .txt
 *      attachment for long transcripts) into the composer for the user
 *      to review and send.
 *
 * Why Claude's path is shorter than the ChatGPT equivalent:
 *   - Exit is a single button click; no toggle aria-label flip to read,
 *     no "post-message vs pre-message" branching.
 *   - The route swap stays inside the same content-script lifetime, so
 *     in-memory state often suffices.  sessionStorage is kept as a
 *     belt-and-suspenders for the rare full-reload fallback.
 */

import { t } from './i18n';
import {
  type ExtractedTurn,
  type HandoffDelivery,
  type TurnRole,
  planHandoffDelivery,
} from './promptBuilder';

/* ---------- selectors ---------- */

const USER_MSG_SELECTOR = '[data-testid="user-message"]';
const ASSISTANT_MSG_SELECTOR = '.font-claude-response';
const TURN_WRAP_SELECTOR = '[data-test-render-count]';
const SCROLL_CONTAINER_SELECTOR = '[data-autoscroll-container="true"]';
const EXIT_INCOGNITO_SELECTOR = 'button[aria-label="Exit incognito"]';
const COMPOSER_SELECTOR = '.ProseMirror[contenteditable="true"]';

const MODAL_CLASS = 'cv-temp-regret-modal';
const BACKDROP_CLASS = 'cv-temp-regret-modal__backdrop';
const OVERLAY_CLASS = 'cv-temp-regret-overlay';

const SCROLL_IDLE_MS = 600;
const SCROLL_MAX_MS = 15_000;
const SCROLL_POLL_MS = 200;
const EXIT_SETTLE_MS = 2_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ---------- incognito detection ---------- */

export function isInIncognitoMode(): boolean {
  try {
    // Claude's incognito URLs look like `/new?incognito=` or
    // `/new?incognito=true`.  Presence of the param key is the
    // authoritative signal — the value may be empty.
    const url = new URL(window.location.href);
    if (url.searchParams.has('incognito')) return true;
  } catch {
    /* malformed URL — fall through to DOM check */
  }
  // DOM fallback: the "Exit incognito" button in the header is only
  // rendered while incognito mode is active.
  return !!document.querySelector(EXIT_INCOGNITO_SELECTOR);
}

/* ---------- DOM extraction ---------- */

function findScrollContainer(): HTMLElement | null {
  // Claude marks its conversation scroll area with
  // `data-autoscroll-container="true"`.  Inside it lives a child div
  // with `[scrollbar-gutter:stable]` — both are scrollable in practice,
  // but the outer one is the canonical handle.
  return document.querySelector<HTMLElement>(SCROLL_CONTAINER_SELECTOR);
}

function normalizeTurnText(el: HTMLElement): string {
  // Clone before scrubbing so we don't modify the page.  Drop action
  // bars, copy/edit buttons, KaTeX visual layout (we keep the
  // mathml source via innerText), inline SVG, and the per-message
  // timestamp pill.
  const clone = el.cloneNode(true) as HTMLElement;
  const dropSelectors = [
    'button',
    '[role="button"]',
    '.katex-html', // visual KaTeX — innerText still gives us the source
    'svg',
    'style',
    'script',
  ];
  for (const sel of dropSelectors) {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  }
  const raw = (clone.innerText || clone.textContent || '').replace(/ /g, ' ');
  return raw
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTurnsFromDom(): ExtractedTurn[] {
  // Walk every render-count wrapper in document order — that's the
  // turn-level granularity Claude exposes — and harvest whichever of
  // the two role markers shows up inside.
  const wrappers = Array.from(document.querySelectorAll<HTMLElement>(TURN_WRAP_SELECTOR));
  const out: ExtractedTurn[] = [];
  const seen = new Set<string>();
  for (const w of wrappers) {
    let role: TurnRole | null = null;
    let body: HTMLElement | null = null;
    const user = w.querySelector<HTMLElement>(USER_MSG_SELECTOR);
    if (user) {
      role = 'human';
      body = user;
    } else {
      const assistant = w.querySelector<HTMLElement>(ASSISTANT_MSG_SELECTOR);
      if (assistant) {
        role = 'assistant';
        body = assistant;
      }
    }
    if (!role || !body) continue;
    const text = normalizeTurnText(body);
    if (!text) continue;
    const key = `${role}:${text.slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, text });
  }
  return out;
}

/* ---------- scroll-to-top with virtualization wait ---------- */

async function scrollToTopAndLoadAll(
  onProgress: (turnsLoaded: number) => void,
): Promise<void> {
  const start = Date.now();
  let lastChangeAt = Date.now();
  let lastCount = document.querySelectorAll(TURN_WRAP_SELECTOR).length;
  onProgress(lastCount);

  while (Date.now() - start < SCROLL_MAX_MS) {
    const container = findScrollContainer();
    if (container) container.scrollTop = 0;
    // Window scroll is a safety net in case Claude's layout ever
    // promotes the page-level scroll instead of the inner container.
    window.scrollTo({ top: 0, behavior: 'auto' });

    await sleep(SCROLL_POLL_MS);

    const count = document.querySelectorAll(TURN_WRAP_SELECTOR).length;
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = Date.now();
      onProgress(count);
    } else if (Date.now() - lastChangeAt >= SCROLL_IDLE_MS) {
      const container2 = findScrollContainer();
      if (!container2 || container2.scrollTop <= 1) return;
      // Container hasn't bottomed out yet; one more poll cycle.
    }
  }
}

/* ---------- leave incognito ---------- */

async function leaveIncognitoMode(): Promise<boolean> {
  const exit = document.querySelector<HTMLElement>(EXIT_INCOGNITO_SELECTOR);
  if (exit) {
    exit.click();
    const start = Date.now();
    while (Date.now() - start < EXIT_SETTLE_MS) {
      if (!isInIncognitoMode()) return true;
      await sleep(80);
    }
    if (!isInIncognitoMode()) return true;
  }
  // Last-resort fallback: navigate to /new directly.  This triggers a
  // page-level navigation, but the sessionStorage hand-off survives
  // and `resumePendingHandoff` will pick it up on the new page.
  window.location.href = '/new';
  const navStart = Date.now();
  while (Date.now() - navStart < EXIT_SETTLE_MS) {
    if (!isInIncognitoMode() && document.querySelector(COMPOSER_SELECTOR)) {
      return true;
    }
    await sleep(80);
  }
  return !isInIncognitoMode();
}

/* ---------- modal + overlay ---------- */

interface ConfirmHandle {
  destroy: () => void;
}

function showConfirmModal(args: {
  onConfirm: () => void;
  onCancel: () => void;
  turnCount: number;
}): ConfirmHandle {
  document.querySelectorAll(`.${BACKDROP_CLASS}`).forEach((n) => n.remove());

  const backdrop = document.createElement('div');
  backdrop.className = BACKDROP_CLASS;

  const card = document.createElement('div');
  card.className = MODAL_CLASS;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');

  const title = document.createElement('h2');
  title.className = `${MODAL_CLASS}__title`;
  title.textContent = t('tempChatRegretConfirmTitle');
  card.appendChild(title);

  const body = document.createElement('div');
  body.className = `${MODAL_CLASS}__body`;

  const head = document.createElement('p');
  head.textContent = t('tempChatRegretConfirmBodyHead');
  body.appendChild(head);

  const detail = document.createElement('p');
  detail.textContent = t('tempChatRegretConfirmBodyDetail', { count: args.turnCount });
  body.appendChild(detail);

  const footerHint = document.createElement('p');
  footerHint.style.opacity = '0.7';
  footerHint.textContent = t('tempChatRegretConfirmBodyFooter');
  body.appendChild(footerHint);

  card.appendChild(body);

  const footer = document.createElement('footer');
  footer.className = `${MODAL_CLASS}__footer`;

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = `${MODAL_CLASS}__btn ${MODAL_CLASS}__btn--ghost`;
  cancelBtn.textContent = t('tempChatRegretConfirmCancel');
  footer.appendChild(cancelBtn);

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = `${MODAL_CLASS}__btn ${MODAL_CLASS}__btn--primary`;
  okBtn.textContent = t('tempChatRegretConfirmContinue');
  footer.appendChild(okBtn);

  card.appendChild(footer);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      handle.destroy();
      args.onCancel();
    }
  };
  const handle: ConfirmHandle = {
    destroy: () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    },
  };
  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', () => {
    handle.destroy();
    args.onCancel();
  });
  okBtn.addEventListener('click', () => {
    handle.destroy();
    args.onConfirm();
  });
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      handle.destroy();
      args.onCancel();
    }
  });
  setTimeout(() => okBtn.focus(), 0);

  return handle;
}

interface OverlayHandle {
  setProgress: (msg: string) => void;
  destroy: () => void;
}

function showLoadingOverlay(initial: string): OverlayHandle {
  document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((n) => n.remove());

  const root = document.createElement('div');
  root.className = OVERLAY_CLASS;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');

  const card = document.createElement('div');
  card.className = `${OVERLAY_CLASS}__card`;

  const spinner = document.createElement('div');
  spinner.className = `${OVERLAY_CLASS}__spinner`;
  card.appendChild(spinner);

  const msg = document.createElement('div');
  msg.className = `${OVERLAY_CLASS}__msg`;
  msg.textContent = initial;
  card.appendChild(msg);

  const hint = document.createElement('div');
  hint.className = `${OVERLAY_CLASS}__hint`;
  hint.textContent = t('tempChatRegretOverlayHint');
  card.appendChild(hint);

  root.appendChild(card);
  document.body.appendChild(root);

  return {
    setProgress: (m) => {
      msg.textContent = m;
    },
    destroy: () => root.remove(),
  };
}

function showToast(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = document.createElement('div');
  el.className = `${OVERLAY_CLASS}__toast ${OVERLAY_CLASS}__toast--${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

/* ---------- handoff payload + delivery ---------- */

const PENDING_KEY = 'cv-pending-temp-regret-handoff';
const PENDING_TTL_MS = 60_000;

interface PendingHandoff {
  delivery: HandoffDelivery;
  storedAt: number;
}

function writePendingHandoff(delivery: HandoffDelivery): void {
  try {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ delivery, storedAt: Date.now() } satisfies PendingHandoff),
    );
  } catch {
    /* sessionStorage unavailable — in-memory path is primary */
  }
}

function readPendingHandoff(): PendingHandoff | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingHandoff>;
    if (
      !parsed ||
      typeof parsed.storedAt !== 'number' ||
      !parsed.delivery ||
      typeof parsed.delivery !== 'object'
    ) {
      return null;
    }
    const d = parsed.delivery as HandoffDelivery;
    if (d.mode === 'inline' && typeof d.text === 'string') {
      return { delivery: d, storedAt: parsed.storedAt };
    }
    if (
      d.mode === 'attachment' &&
      typeof d.directive === 'string' &&
      typeof d.attachment === 'string' &&
      typeof d.filename === 'string'
    ) {
      return { delivery: d, storedAt: parsed.storedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function clearPendingHandoff(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Dispatch a synthetic `paste` ClipboardEvent at the composer.
 *
 * Tiptap/ProseMirror (Claude's editor) maintains its own document model
 * and re-renders from it on every transaction — raw `execCommand`
 * insertions get clobbered on the next render tick.  A real `paste`
 * event goes through ProseMirror's paste handler, which calls its own
 * transaction API and the change sticks.
 *
 * For File payloads, Claude's paste handler reads `DataTransfer.files`
 * and converts the file into its native attachment chip — same code
 * path the user gets from manual paste of a giant blob.
 */
function dispatchSyntheticPaste(
  input: HTMLElement,
  text: string | null,
  file: File | null,
): boolean {
  input.focus();
  const dt = new DataTransfer();
  if (text) dt.setData('text/plain', text);
  if (file) dt.items.add(file);
  const evt = new ClipboardEvent('paste', {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  // Some browsers strip the payload from the constructor — verify
  // before dispatching so the caller can pick a fallback path.
  const haveText =
    !text || (evt.clipboardData && evt.clipboardData.getData('text/plain') === text);
  const haveFile =
    !file || (evt.clipboardData && evt.clipboardData.files && evt.clipboardData.files.length > 0);
  if (!haveText || !haveFile) return false;
  input.dispatchEvent(evt);
  return true;
}

async function deliverHandoff(
  input: HTMLElement,
  delivery: HandoffDelivery,
): Promise<boolean> {
  if (delivery.mode === 'inline') {
    if (dispatchSyntheticPaste(input, delivery.text, null)) return true;
    // Inline fallback: direct text insertion via the shared helper.
    // chatInput's insertTextIntoChatInput already knows Claude's
    // ProseMirror dance.
    const { insertTextIntoChatInput } = await import('../chatInput/index');
    insertTextIntoChatInput(delivery.text, input);
    return true;
  }
  // Attachment: directive paste + transcript .txt file paste.
  if (!dispatchSyntheticPaste(input, delivery.directive, null)) {
    const { insertTextIntoChatInput } = await import('../chatInput/index');
    insertTextIntoChatInput(delivery.directive, input);
  }
  try {
    const file = new File([delivery.attachment], delivery.filename, { type: 'text/plain' });
    if (!dispatchSyntheticPaste(input, null, file)) {
      throw new Error('synthetic paste stripped file payload');
    }
    return true;
  } catch (err) {
    console.warn('[Claude-Voyager] temp-regret: file paste failed, falling back to inline', err);
    const { insertTextIntoChatInput } = await import('../chatInput/index');
    insertTextIntoChatInput(delivery.directive + '\n\n' + delivery.attachment, input);
    return false;
  }
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard may be unavailable — input fill is the primary path */
  }
}

/* ---------- public entry points ---------- */

let inFlight = false;

export async function resumePendingHandoff(): Promise<void> {
  const pending = readPendingHandoff();
  if (!pending) return;
  if (Date.now() - pending.storedAt > PENDING_TTL_MS) {
    clearPendingHandoff();
    return;
  }
  if (isInIncognitoMode()) {
    // Still in incognito for some reason — bail; the user clearly
    // didn't land on a fresh persistent chat.
    return;
  }
  const start = Date.now();
  while (Date.now() - start < 6_000) {
    const input = document.querySelector<HTMLElement>(COMPOSER_SELECTOR);
    if (input) {
      await deliverHandoff(input, pending.delivery);
      clearPendingHandoff();
      showToast(
        pending.delivery.mode === 'attachment'
          ? t('tempChatRegretOkAttachment', {
              count: '?',
              filename: pending.delivery.filename,
            })
          : t('tempChatRegretOkInline', { count: '?' }),
        'info',
      );
      return;
    }
    await sleep(150);
  }
  // Timed out — leave the pending entry; next page load tries again
  // unless the TTL kills it first.
}

export async function runTempChatRegret(): Promise<void> {
  if (inFlight) return;
  if (!isInIncognitoMode()) {
    showToast(t('tempChatRegretErrNotInTempMode'), 'error');
    return;
  }
  inFlight = true;
  try {
    const initialTurnCount = document.querySelectorAll(TURN_WRAP_SELECTOR).length;
    if (initialTurnCount === 0) {
      showToast(t('tempChatRegretErrNoMessages'), 'error');
      return;
    }

    const confirmed = await new Promise<boolean>((resolve) => {
      showConfirmModal({
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
        turnCount: initialTurnCount,
      });
    });
    if (!confirmed) return;

    const overlay = showLoadingOverlay(t('tempChatRegretMsgLoading'));
    try {
      await scrollToTopAndLoadAll((count) => {
        overlay.setProgress(t('tempChatRegretMsgLoaded', { count }));
      });

      overlay.setProgress(t('tempChatRegretMsgExtracting'));
      const turns = extractTurnsFromDom();
      if (turns.length === 0) {
        overlay.destroy();
        showToast(t('tempChatRegretErrExtractFailed'), 'error');
        return;
      }

      const delivery = planHandoffDelivery(turns);
      // Stash to sessionStorage BEFORE leaving incognito.  In the rare
      // case `leaveIncognitoMode` falls back to a full reload, the
      // in-memory delivery reference dies with the page but the
      // sessionStorage entry survives — `resumePendingHandoff` reads
      // it back on the next bootstrap.
      writePendingHandoff(delivery);

      overlay.setProgress(t('tempChatRegretMsgLeavingTemp'));
      const left = await leaveIncognitoMode();
      if (!left) {
        overlay.destroy();
        clearPendingHandoff();
        showToast(t('tempChatRegretErrCantLeaveTemp'), 'error');
        return;
      }

      // Give Claude a frame to remount the composer post-route.
      await sleep(250);

      overlay.setProgress(
        delivery.mode === 'attachment'
          ? t('tempChatRegretMsgFillingAttachment')
          : t('tempChatRegretMsgFillingInline'),
      );
      const input = document.querySelector<HTMLElement>(COMPOSER_SELECTOR);
      if (!input) {
        overlay.destroy();
        const fallback =
          delivery.mode === 'inline'
            ? delivery.text
            : delivery.directive + '\n\n' + delivery.attachment;
        await copyToClipboard(fallback);
        showToast(t('tempChatRegretErrInputNotFound'), 'error');
        return;
      }
      const ok = await deliverHandoff(input, delivery);
      clearPendingHandoff();
      // Clipboard safety net so the user can re-paste if anything
      // looks off when they review the input box.
      const clipboardCopy =
        delivery.mode === 'inline'
          ? delivery.text
          : delivery.directive + '\n\n' + delivery.attachment;
      await copyToClipboard(clipboardCopy);

      overlay.destroy();
      if (ok) {
        showToast(
          delivery.mode === 'attachment'
            ? t('tempChatRegretOkAttachment', {
                count: turns.length,
                filename: delivery.filename,
              })
            : t('tempChatRegretOkInline', { count: turns.length }),
          'info',
        );
      } else {
        showToast(t('tempChatRegretErrPartial'), 'error');
      }
    } catch (err) {
      overlay.destroy();
      console.error('[Claude-Voyager] temp-chat regret failed', err);
      const msg = (err as Error)?.message ?? String(err);
      showToast(`${t('tempChatRegretErrFailed')}: ${msg}`, 'error');
    }
  } finally {
    inFlight = false;
  }
}
