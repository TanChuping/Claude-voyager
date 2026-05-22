/**
 * claudeDom.ts
 * Centralised DOM helpers for Claude.ai pages.
 *
 * Claude URL pattern: https://claude.ai/chat/<uuid>
 *   (legacy ChatGPT used /c/<uuid>; the rest of the codebase still calls the
 *   functions with "ChatGpt" suffix — see chatgptDom.ts compat shim.)
 *
 * Claude sidebar structure:
 *   <nav aria-label="Sidebar" ...>
 *     ... <ul class="flex flex-col gap-px">
 *           <li><div ...><a href="/chat/<uuid>">...<span class="truncate">title</span></a>...</div></li>
 *           ...
 *
 * Claude message DOM (inside a `[data-autoscroll-container="true"]` element):
 *   <div data-test-render-count="N">
 *     <div data-user-message-bubble="true">
 *       <div data-testid="user-message">...</div>
 *     </div>
 *     OR
 *     <div data-is-streaming="false">
 *       <div class="font-claude-response">...</div>
 *     </div>
 *   </div>
 */

// -----------------------------------------------------------------------------
// Selectors – exported so other modules don't hard-code strings.
// -----------------------------------------------------------------------------

export const CLAUDE_URL_PREFIX = '/chat/';

/** Anchors in the sidebar that link to a specific conversation. */
export const CLAUDE_CONVERSATION_LINK_SELECTOR = 'a[href^="/chat/"]';

/** Title text node inside a conversation anchor. */
export const CLAUDE_CONVERSATION_TITLE_SELECTOR = 'span.truncate';

/** Main scrollable container that holds the message stream. */
export const CLAUDE_AUTOSCROLL_CONTAINER_SELECTOR = '[data-autoscroll-container="true"]';

/** Wrapper attribute marking each rendered turn (user OR assistant). */
export const CLAUDE_MESSAGE_RENDER_WRAPPER_SELECTOR = '[data-test-render-count]';

/** User turn content node. */
export const CLAUDE_USER_MESSAGE_SELECTOR = '[data-testid="user-message"]';

/** User-message bubble (the rounded background around the user text). */
export const CLAUDE_USER_BUBBLE_SELECTOR = '[data-user-message-bubble="true"]';

/** Assistant turn content node. */
export const CLAUDE_ASSISTANT_MESSAGE_SELECTOR = 'div.font-claude-response';

/** Assistant streaming flag wrapper. */
export const CLAUDE_ASSISTANT_STREAM_SELECTOR = '[data-is-streaming]';

/** Assistant action-bar copy button — used by clipboard-based export. */
export const CLAUDE_ASSISTANT_COPY_BUTTON_SELECTOR = 'button[data-testid="action-bar-copy"]';

/** The visible chat input. */
export const CLAUDE_CHAT_INPUT_SELECTOR = 'div[data-testid="chat-input"]';

/** Toolbar action area (next to send button etc.). */
export const CLAUDE_TOOLBAR_ACTIONS_SELECTOR = '[data-testid="wiggle-controls-actions"]';

/** Candidate sidebar root elements, in priority order. */
const SIDEBAR_SELECTORS = [
  'nav[aria-label="Sidebar"]',
  'nav[aria-label*="sidebar" i]',
  'nav',
  'aside',
  '[id*="sidebar" i]',
];

/** Candidate history-container selectors inside the sidebar. */
const HISTORY_CONTAINER_SELECTORS = [
  'ul.flex.flex-col.gap-px',
  'nav ul',
  'ul',
  'ol',
  'section',
];

// -----------------------------------------------------------------------------
// Conversation ID helpers
// -----------------------------------------------------------------------------

export function normalizeClaudeConversationId(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function extractClaudeConversationIdFromUrl(
  href: string | null | undefined,
): string | null {
  if (!href) return null;
  try {
    const parsed = new URL(href, window.location.origin);
    const match = parsed.pathname.match(/(?:^|\/)chat\/([^/?#]+)/i);
    return normalizeClaudeConversationId(match?.[1]);
  } catch {
    const match = href.match(/(?:^|\/)chat\/([^/?#]+)/i);
    return normalizeClaudeConversationId(match?.[1]);
  }
}

/** Convenience for callers that want the *current* page's conversation id. */
export function getCurrentClaudeConversationId(): string | null {
  return extractClaudeConversationIdFromUrl(window.location.pathname);
}

// -----------------------------------------------------------------------------
// Conversation row / link helpers
// -----------------------------------------------------------------------------

export function getClaudeConversationLink(root: ParentNode): HTMLAnchorElement | null {
  if (root instanceof HTMLAnchorElement && root.matches(CLAUDE_CONVERSATION_LINK_SELECTOR)) {
    return root;
  }
  return root.querySelector<HTMLAnchorElement>(CLAUDE_CONVERSATION_LINK_SELECTOR);
}

export function getClaudeConversationElement(element: HTMLElement): HTMLElement {
  // Walk up to the nearest <li>, which is the most stable per-conversation row.
  const candidate = element.closest<HTMLElement>(
    'li, [role="listitem"], [role="treeitem"], [data-testid*="conversation" i]',
  );
  if (candidate && getClaudeConversationLink(candidate)) {
    return candidate;
  }
  return element;
}

export function getClaudeConversationTitle(element: HTMLElement): string | null {
  const link = getClaudeConversationLink(element);
  if (link) {
    // Preferred: the <span class="truncate"> inside the anchor.
    const span = link.querySelector(CLAUDE_CONVERSATION_TITLE_SELECTOR);
    const fromSpan = (span?.textContent || '').trim();
    if (fromSpan) return cleanupTitle(fromSpan);
  }

  const raw =
    link?.getAttribute('aria-label') ||
    link?.getAttribute('title') ||
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    link?.textContent ||
    element.textContent ||
    '';

  return cleanupTitle(raw) || null;
}

function cleanupTitle(raw: string): string | null {
  const title = raw
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter(
      (part) =>
        !/^(claude|chats|recents|today|yesterday|previous 7 days|new chat|更多|聊天|最近)$/i.test(
          part,
        ),
    )
    .find((part) => part.length > 1);
  return title || null;
}

export function getClaudeConversationUrl(element: HTMLElement): string | null {
  const link = getClaudeConversationLink(element);
  return link?.href || link?.getAttribute('href') || null;
}

export function getClaudeConversationId(element: HTMLElement): string | null {
  const href = getClaudeConversationUrl(element);
  return extractClaudeConversationIdFromUrl(href);
}

// -----------------------------------------------------------------------------
// Sidebar / history helpers
// -----------------------------------------------------------------------------

export function findClaudeSidebar(): HTMLElement | null {
  for (const selector of SIDEBAR_SELECTORS) {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const withLinks = candidates.find((el) =>
      el.querySelector(CLAUDE_CONVERSATION_LINK_SELECTOR),
    );
    if (withLinks) return withLinks;
    if (candidates[0]) {
      // Sidebar may be visible but empty (e.g. no conversations).
      const aria = candidates[0].getAttribute('aria-label');
      if (aria && /sidebar/i.test(aria)) return candidates[0];
    }
  }

  const firstLink = document.querySelector<HTMLAnchorElement>(CLAUDE_CONVERSATION_LINK_SELECTOR);
  return firstLink?.closest<HTMLElement>('[id*="sidebar" i], aside, nav') || null;
}

export function findClaudeHistoryContainer(sidebar: HTMLElement): HTMLElement | null {
  const firstLink = sidebar.querySelector<HTMLAnchorElement>(CLAUDE_CONVERSATION_LINK_SELECTOR);
  if (!firstLink) {
    for (const selector of HISTORY_CONTAINER_SELECTORS) {
      const container = sidebar.querySelector<HTMLElement>(selector);
      if (container) return container;
    }
    return sidebar;
  }

  // Walk up from the first link, keeping the deepest element that holds many links.
  let node: HTMLElement | null = firstLink;
  let best: HTMLElement = firstLink;
  while (node && node !== sidebar) {
    const count = node.querySelectorAll(CLAUDE_CONVERSATION_LINK_SELECTOR).length;
    if (count > 1 || HISTORY_CONTAINER_SELECTORS.some((sel) => node?.matches(sel))) {
      best = node;
    }
    node = node.parentElement;
  }
  return best;
}

export function getClaudeConversationElements(root: ParentNode = document): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const result: HTMLElement[] = [];

  root.querySelectorAll<HTMLAnchorElement>(CLAUDE_CONVERSATION_LINK_SELECTOR).forEach((link) => {
    const row = getClaudeConversationElement(link);
    if (!seen.has(row)) {
      seen.add(row);
      result.push(row);
    }
  });

  return result;
}

// -----------------------------------------------------------------------------
// Message helpers (used by timeline / export)
// -----------------------------------------------------------------------------

export function findClaudeScrollContainer(): HTMLElement | null {
  const explicit = document.querySelector<HTMLElement>(CLAUDE_AUTOSCROLL_CONTAINER_SELECTOR);
  if (explicit) return explicit;

  // Fallback: find the largest element with overflow-y scroll that holds messages.
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('div'));
  for (const el of candidates) {
    if (!el.querySelector(CLAUDE_MESSAGE_RENDER_WRAPPER_SELECTOR)) continue;
    const cs = getComputedStyle(el);
    if (
      (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight + 50
    ) {
      return el;
    }
  }
  return null;
}

export function getClaudeMessageWrappers(
  root: ParentNode | null = findClaudeScrollContainer(),
): HTMLElement[] {
  const source: ParentNode = root || document;
  return Array.from(
    source.querySelectorAll<HTMLElement>(CLAUDE_MESSAGE_RENDER_WRAPPER_SELECTOR),
  );
}

export type ClaudeTurnRole = 'user' | 'assistant';

export function getClaudeTurnRole(wrapper: Element): ClaudeTurnRole | null {
  if (wrapper.querySelector(CLAUDE_USER_MESSAGE_SELECTOR)) return 'user';
  if (wrapper.querySelector(CLAUDE_ASSISTANT_MESSAGE_SELECTOR)) return 'assistant';
  if (wrapper.querySelector(CLAUDE_ASSISTANT_STREAM_SELECTOR)) return 'assistant';
  return null;
}

export function extractClaudeUserText(wrapper: Element): string {
  const el = wrapper.querySelector(CLAUDE_USER_MESSAGE_SELECTOR);
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function extractClaudeAssistantText(wrapper: Element): string {
  const el =
    wrapper.querySelector(CLAUDE_ASSISTANT_MESSAGE_SELECTOR) ||
    wrapper.querySelector(CLAUDE_ASSISTANT_STREAM_SELECTOR);
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}
