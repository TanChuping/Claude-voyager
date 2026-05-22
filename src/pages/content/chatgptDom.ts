/**
 * chatgptDom.ts
 *
 * BACKWARD-COMPAT SHIM.
 *
 * The codebase was originally written for ChatGPT.  All call sites still
 * import these "ChatGpt"-suffixed helpers — instead of rewriting every
 * caller, we re-export the Claude implementations under the old names.
 *
 * New code should import from ./claudeDom directly.
 */

export {
  extractClaudeConversationIdFromUrl as extractChatGptConversationIdFromUrl,
  normalizeClaudeConversationId as normalizeChatGptConversationId,
  getClaudeConversationLink as getChatGptConversationLink,
  getClaudeConversationElement as getChatGptConversationElement,
  getClaudeConversationTitle as getChatGptConversationTitle,
  getClaudeConversationUrl as getChatGptConversationUrl,
  getClaudeConversationId as getChatGptConversationId,
  findClaudeSidebar as findChatGptSidebar,
  findClaudeHistoryContainer as findChatGptHistoryContainer,
  getClaudeConversationElements as getChatGptConversationElements,
} from './claudeDom';
