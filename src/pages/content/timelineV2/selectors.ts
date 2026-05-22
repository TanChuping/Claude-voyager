/**
 * Claude.ai DOM selectors — verified live via browser-harness on 2026-05-22.
 * Ported from claude-nexus (which has a working Claude implementation) and
 * cross-checked against the live DOM.
 *
 * The full TimelineManager in `../timeline/manager.ts` is the GPT-Voyager
 * legacy implementation that assumed ChatGPT's `<section data-testid=
 * "conversation-turn-N" data-turn-id>` virtualisation wrappers.  Claude has
 * none of those — its DOM is much flatter.  TimelineV2 is the Claude-native
 * reboot.
 */

/**
 * Strict — must be the chat scroller, not the sidebar.  The sidebar ALSO has
 * `overflow-y-auto [scrollbar-gutter:stable]` but does NOT have the
 * `data-autoscroll-container` attribute. Verified live on 2026-05-22.
 */
export const SCROLL_CONTAINER_SELECTOR = '[data-autoscroll-container="true"]';

/** Each `<div data-test-render-count>` wraps ONE message (user or assistant). */
export const MESSAGE_RENDER_WRAPPER_SELECTOR = '[data-test-render-count]';

/** The user-message inner bubble.  We use its presence to classify the wrapper. */
export const USER_MESSAGE_SELECTOR = '[data-testid="user-message"]';

/** Assistant response root — used to count assistant nodes for tooltips later. */
export const ASSISTANT_MESSAGE_SELECTOR = '.font-claude-response, [data-is-streaming]';

/** Outer sidebar nav (aria-label="Sidebar"). */
export const SIDEBAR_NAV_SELECTOR = 'nav[aria-label="Sidebar"]';

/** Fallback: the UL that lists conversation links. */
export const SIDEBAR_FALLBACK_CONTAINER_SELECTOR = 'nav ul.flex.flex-col.gap-px';

/** Conversation link in the sidebar (also matches the active chat link). */
export const CONVERSATION_LINK_SELECTOR = 'a[href^="/chat/"]';

/** Per-message toolbar copy button — used for the export pipeline. */
export const ASSISTANT_COPY_BUTTON_SELECTOR = 'button[data-testid="action-bar-copy"]';

/** Conversation title in the top bar. */
export const CONVERSATION_TITLE_SELECTOR = 'button[data-testid="chat-menu-trigger"]';
