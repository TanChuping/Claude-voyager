/**
 * Claude conversation API types.
 *
 * Endpoint:
 *   GET /api/organizations/<org_uuid>/chat_conversations/<conv_uuid>
 *        ?tree=True&rendering_mode=messages&render_all_tools=true
 *
 * Response shape (top-level):
 *   { uuid, name, summary, model, created_at, updated_at, settings,
 *     is_starred, is_temporary, platform, current_leaf_message_uuid,
 *     chat_messages: [ClaudeApiMessage, ...] }
 *
 * Each `chat_messages[i]` (a.k.a. "message"):
 *   { uuid, parent_message_uuid, sender, index, created_at, updated_at,
 *     truncated, stop_reason?, text, content: [ContentBlock, ...],
 *     attachments: [...], files: [...], sync_sources: [...] }
 *
 * Content block types we've observed:
 *   - { type: "text", text, start_timestamp, stop_timestamp, citations }
 *   - { type: "tool_use", name, input, ... }
 *   - { type: "tool_result", tool_use_id, content, is_error, ... }
 *   - { type: "thinking", text, ... }  (only on extended-thinking responses)
 */

export type ClaudeSender = 'human' | 'assistant';

export interface ClaudeContentBlockBase {
  type: string;
  start_timestamp?: string;
  stop_timestamp?: string;
  citations?: unknown[];
  [k: string]: unknown;
}

export interface ClaudeContentText extends ClaudeContentBlockBase {
  type: 'text';
  text: string;
}

export interface ClaudeContentToolUse extends ClaudeContentBlockBase {
  type: 'tool_use';
  name?: string;
  input?: unknown;
  id?: string;
}

export interface ClaudeContentToolResult extends ClaudeContentBlockBase {
  type: 'tool_result';
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

export interface ClaudeContentThinking extends ClaudeContentBlockBase {
  type: 'thinking';
  text?: string;
}

export type ClaudeContentBlock =
  | ClaudeContentText
  | ClaudeContentToolUse
  | ClaudeContentToolResult
  | ClaudeContentThinking
  | ClaudeContentBlockBase;

export interface ClaudeAttachment {
  id?: string;
  file_name?: string;
  file_size?: number;
  file_type?: string;
  extracted_content?: string;
  created_at?: string;
  [k: string]: unknown;
}

export interface ClaudeFile {
  file_uuid?: string;
  file_name?: string;
  file_kind?: string;
  preview_url?: string;
  [k: string]: unknown;
}

export interface ClaudeApiMessage {
  uuid: string;
  parent_message_uuid?: string | null;
  sender: ClaudeSender;
  index?: number;
  text?: string;
  content: ClaudeContentBlock[];
  attachments?: ClaudeAttachment[];
  files?: ClaudeFile[];
  files_v2?: ClaudeFile[];
  sync_sources?: unknown[];
  created_at?: string;
  updated_at?: string;
  truncated?: boolean;
  stop_reason?: string;
  [k: string]: unknown;
}

export interface ClaudeApiConversation {
  uuid: string;
  name?: string | null;
  summary?: string | null;
  model?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  settings?: Record<string, unknown> | null;
  is_starred?: boolean;
  is_temporary?: boolean;
  platform?: string | null;
  current_leaf_message_uuid?: string | null;
  chat_messages: ClaudeApiMessage[];
  project_uuid?: string | null;
  [k: string]: unknown;
}

// -----------------------------------------------------------------------------
// COMPAT: many call sites still type-import the legacy `ApiConversation`
// (ChatGPT-shaped) name.  Re-export the Claude type under that name so we
// don't have to update every importer.
// -----------------------------------------------------------------------------
export type ApiConversation = ClaudeApiConversation;
export type ConversationNodeMessage = ClaudeApiMessage;
// Soft alias so legacy code that did `ApiContent.content_type` reads doesn't
// blow up at type-check time.  We don't actually populate the union here.
export interface ApiContent {
  content_type?: string;
  parts?: unknown[];
  text?: string;
  language?: string;
  [k: string]: unknown;
}
export interface ApiAttachment {
  id?: string;
  name?: string;
  file_name?: string;
  mimeType?: string;
  mime_type?: string;
  file_type?: string;
  [k: string]: unknown;
}
export interface ConversationNode {
  id: string;
  message: ClaudeApiMessage | null;
  parent?: string | null;
  children: string[];
}

// -----------------------------------------------------------------------------
// Normalised linear form (platform-agnostic) — consumed by export / timeline.
// -----------------------------------------------------------------------------

export interface LinearAttachment {
  name: string;
  mimeType?: string;
  size?: number;
  extractedContent?: string;
}

export interface LinearMessage {
  /** Turn id with `u-` prefix when raw uuid; matches timeline manager's scheme. */
  turnId: string;
  /** Raw message uuid from API (no prefix). */
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  authorName?: string | null;
  text: string;
  attachments: LinearAttachment[];
  /** Unix epoch ms.  Null when API didn't supply a timestamp. */
  createTime: number | null;
  /**
   * Original content_type/role string from the source block.  For Claude we
   * record the *first* content block's type ("text", "tool_use",
   * "tool_result", "thinking", …) so the simplified-export filter can drop
   * tool-only turns.
   */
  contentType?: string;
  /**
   * Channel hint.  Always `null` for Claude (no equivalent of ChatGPT's
   * `final` vs `commentary`).  Carried so the existing export filter
   * signatures don't need to change.
   */
  channel?: string | null;
}

export interface LinearConversation {
  id: string;
  title: string;
  /** Unix epoch ms. */
  createTime: number | null;
  /** Unix epoch ms. */
  updateTime: number | null;
  messages: LinearMessage[];
}

export function withTurnIdPrefix(messageId: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)
    ? `u-${messageId}`
    : messageId;
}

/** ISO date string → unix epoch ms.  Returns null on parse failure. */
export function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
