/**
 * Claude conversation walker.
 *
 * Claude's API returns a flat `chat_messages` array (chronological by `index`)
 * plus `current_leaf_message_uuid` and `parent_message_uuid` on every message.
 *
 * For a *non-branching* conversation, sorting by `index` already gives the
 * correct linear order.  For *branching* conversations (when the user edits a
 * past message), the array still contains the orphaned branches — we walk
 * back from `current_leaf_message_uuid` via `parent_message_uuid` to recover
 * the *currently visible* chain only, matching what the Claude UI shows.
 */
import type {
  ClaudeApiConversation,
  ClaudeApiMessage,
  ClaudeAttachment,
  ClaudeContentBlock,
  LinearAttachment,
  LinearConversation,
  LinearMessage,
} from './types';
import { isoToMs, withTurnIdPrefix } from './types';

/**
 * Walk `parent_message_uuid` chain from the current leaf back to root, then
 * reverse to give chronological order.  Falls back to `index` ordering when
 * the leaf isn't set (very new conversations).
 */
function walkChain(api: ClaudeApiConversation): ClaudeApiMessage[] {
  const messages = Array.isArray(api.chat_messages) ? api.chat_messages : [];
  if (messages.length === 0) return [];

  const byUuid = new Map<string, ClaudeApiMessage>();
  for (const m of messages) {
    if (m && typeof m.uuid === 'string') byUuid.set(m.uuid, m);
  }

  const leaf = api.current_leaf_message_uuid;
  if (leaf && byUuid.has(leaf)) {
    const result: ClaudeApiMessage[] = [];
    const visited = new Set<string>();
    let cursor: string | null | undefined = leaf;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const node = byUuid.get(cursor);
      if (!node) break;
      result.push(node);
      cursor = node.parent_message_uuid ?? null;
      // Root sentinel observed in Claude payloads:
      if (cursor === '00000000-0000-4000-8000-000000000000') break;
    }
    if (result.length > 0) return result.reverse();
  }

  // Fallback — order by index (or array order).
  const sorted = [...messages].sort((a, b) => {
    const ai = typeof a.index === 'number' ? a.index : 0;
    const bi = typeof b.index === 'number' ? b.index : 0;
    return ai - bi;
  });
  return sorted;
}

/**
 * Pull readable text out of a single content block.  Wraps `tool_use` and
 * `tool_result` in fenced code so they survive in markdown export.
 */
export function renderBlock(block: ClaudeContentBlock): string {
  if (!block || typeof block !== 'object') return '';
  const t = String(block.type || '').toLowerCase();

  switch (t) {
    case 'text': {
      const text = typeof (block as { text?: unknown }).text === 'string'
        ? ((block as { text: string }).text)
        : '';
      return text;
    }
    case 'thinking': {
      // Extended thinking — render as a markdown quote so it's visually distinct.
      const text = typeof (block as { text?: unknown }).text === 'string'
        ? ((block as { text: string }).text)
        : '';
      if (!text) return '';
      return text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    }
    case 'tool_use': {
      const name = typeof (block as { name?: unknown }).name === 'string'
        ? (block as { name: string }).name
        : 'tool';
      const input = (block as { input?: unknown }).input;
      let inputStr = '';
      try {
        inputStr = JSON.stringify(input ?? null, null, 2);
      } catch {
        inputStr = String(input ?? '');
      }
      return `\`\`\`json\n// tool_use: ${name}\n${inputStr}\n\`\`\``;
    }
    case 'tool_result': {
      const content = (block as { content?: unknown }).content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        // Sometimes tool_result.content is itself an array of {type:"text", text:"..."}.
        text = content
          .map((c) => {
            if (typeof c === 'string') return c;
            if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') {
              return (c as { text: string }).text;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n');
      } else if (content && typeof content === 'object') {
        try {
          text = JSON.stringify(content, null, 2);
        } catch {
          text = '';
        }
      }
      if (!text) return '';
      return `\`\`\`\n// tool_result\n${text}\n\`\`\``;
    }
    default: {
      // Unknown block type — best-effort `.text` extraction.
      const maybeText = (block as { text?: unknown }).text;
      if (typeof maybeText === 'string') return maybeText;
      return '';
    }
  }
}

function renderMessageContent(message: ClaudeApiMessage): string {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const parts = blocks.map(renderBlock).filter((s) => s.length > 0);
  if (parts.length > 0) return parts.join('\n\n');
  // Legacy fallback: some early Claude messages only carry top-level `text`.
  if (typeof message.text === 'string') return message.text;
  return '';
}

function normalizeRole(sender: string | undefined): LinearMessage['role'] {
  const s = (sender || '').toLowerCase();
  if (s === 'human') return 'user';
  if (s === 'assistant') return 'assistant';
  if (s === 'system') return 'system';
  return 'tool';
}

function pickAttachments(message: ClaudeApiMessage): LinearAttachment[] {
  const raw = Array.isArray(message.attachments) ? message.attachments : [];
  const out: LinearAttachment[] = [];
  const seen = new Set<string>();
  for (const a of raw as ClaudeAttachment[]) {
    const name =
      typeof a?.file_name === 'string' ? a.file_name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      mimeType: typeof a.file_type === 'string' ? a.file_type : undefined,
      size: typeof a.file_size === 'number' ? a.file_size : undefined,
      extractedContent:
        typeof a.extracted_content === 'string' ? a.extracted_content : undefined,
    });
  }
  return out;
}

/**
 * Walk Claude's API payload and produce the linear conversation we export from.
 */
export function walkMapping(api: ClaudeApiConversation): LinearConversation {
  const chain = walkChain(api);
  const messages: LinearMessage[] = [];

  for (const msg of chain) {
    if (!msg) continue;
    const role = normalizeRole(msg.sender);
    const text = renderMessageContent(msg);
    const attachments = pickAttachments(msg);
    if (!text && attachments.length === 0) {
      // Skip messages that contributed nothing visible (e.g. a tool_use-only
      // turn with no rendered content)
      if (role !== 'user') continue;
    }

    // First content-block type — used by simplified-export filter.
    const firstBlock = Array.isArray(msg.content) ? msg.content[0] : null;
    const contentType =
      firstBlock && typeof firstBlock.type === 'string' ? firstBlock.type : undefined;

    messages.push({
      turnId: withTurnIdPrefix(msg.uuid),
      messageId: msg.uuid,
      role,
      authorName: null,
      text,
      attachments,
      createTime: isoToMs(msg.created_at),
      contentType,
      channel: null,
    });
  }

  return {
    id: String(api.uuid || ''),
    title: typeof api.name === 'string' && api.name ? api.name : 'Untitled',
    createTime: isoToMs(api.created_at ?? null),
    updateTime: isoToMs(api.updated_at ?? null),
    messages,
  };
}

// Legacy export name (some tests reference it).
export const renderContent = renderBlock;
