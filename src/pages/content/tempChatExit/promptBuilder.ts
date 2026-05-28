/**
 * Build the hand-off prompt that resumes an incognito Claude chat in
 * a fresh persistent conversation.
 *
 * The prompt has two parts:
 *   1. A short directive in the user's language ("here is the temp-chat
 *      transcript, please continue seamlessly, repeat the last assistant
 *      message as the bridging line").
 *   2. The transcript itself, split per turn with `## You` / `## Claude`
 *      markdown headers (kept in English since they're semantic tags the
 *      model reads structurally, not display text).
 *
 * Delivery strategy is chosen by size: short transcripts go inline into
 * the composer; long ones become a .txt attachment dispatched as a
 * synthetic paste event so Tiptap/ProseMirror's paste handler converts
 * it into Claude's native attachment chip.
 */

import { t } from './i18n';

export type TurnRole = 'human' | 'assistant';

export interface ExtractedTurn {
  role: TurnRole;
  text: string;
}

/**
 * Threshold for inline-vs-attachment delivery.  5000 chars is well
 * under Claude's composer working capacity and below any reasonable
 * auto-attach threshold we might trip.  Long transcripts get the file
 * path so the composer stays readable when the user reviews the
 * prompt before sending.
 */
export const HANDOFF_PASTE_THRESHOLD_CHARS = 5000;

function fenceIfNeeded(text: string): string {
  // Wrap turns that already contain a triple-backtick code fence with
  // tildes instead, so we don't accidentally close a fence we didn't
  // open.  Simpler than tracking depth.
  if (/^```/m.test(text)) {
    return `~~~\n${text}\n~~~`;
  }
  return text;
}

export function buildTranscriptMarkdown(turns: ExtractedTurn[]): string {
  if (turns.length === 0) return '_(empty — no extractable messages)_';
  const lines: string[] = [];
  for (const turn of turns) {
    lines.push(turn.role === 'human' ? '## You' : '## Claude');
    lines.push('');
    lines.push(fenceIfNeeded(turn.text.trim() || '_(empty turn)_'));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function inlineDirective(): string {
  return [
    t('tempChatRegretDirectiveTitle'),
    '',
    t('tempChatRegretDirectiveInlineBody'),
  ].join('\n');
}

function attachmentDirective(): string {
  return [
    t('tempChatRegretDirectiveTitle'),
    '',
    t('tempChatRegretDirectiveAttachmentBody'),
  ].join('\n');
}

export function buildInlineHandoffPrompt(turns: ExtractedTurn[]): string {
  return [
    inlineDirective(),
    '',
    t('tempChatRegretTranscriptStart'),
    '',
    buildTranscriptMarkdown(turns),
    '',
    t('tempChatRegretTranscriptEnd'),
  ].join('\n');
}

export type HandoffDelivery =
  | { mode: 'inline'; text: string }
  | { mode: 'attachment'; directive: string; attachment: string; filename: string };

export function planHandoffDelivery(turns: ExtractedTurn[]): HandoffDelivery {
  const transcript = buildTranscriptMarkdown(turns);
  if (transcript.length <= HANDOFF_PASTE_THRESHOLD_CHARS) {
    return { mode: 'inline', text: buildInlineHandoffPrompt(turns) };
  }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return {
    mode: 'attachment',
    directive: attachmentDirective(),
    attachment: transcript,
    filename: `incognito-handoff-${stamp}.txt`,
  };
}
