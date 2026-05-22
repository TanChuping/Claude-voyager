/**
 * Attachment type detection + per-type color mapping.
 *
 * Design ported from GPT-Voyager's `timeline/attachments.ts` (ATTACHMENT_COLOR
 * lookup pattern). Recolored to Claude's warm palette — every chip stays
 * inside the米色 / orange / brown family so it doesn't clash with the
 * timeline bar background.
 */

export type AttachmentType =
  | 'text'
  | 'pdf'
  | 'image'
  | 'code'
  | 'markdown'
  | 'csv'
  | 'json'
  | 'doc'
  | 'sheet'
  | 'audio'
  | 'video'
  | 'archive'
  | 'other';

export type AttachmentInfo = {
  type: AttachmentType;
  /** Short label shown in the chip, e.g. "PDF", "TXT", "PY". */
  label: string;
  /** Best-effort file name / preview (already truncated). */
  name: string;
};

const TYPE_BY_EXT: Record<string, AttachmentType> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  py: 'code',
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  java: 'code',
  cpp: 'code',
  c: 'code',
  h: 'code',
  rs: 'code',
  go: 'code',
  rb: 'code',
  php: 'code',
  sh: 'code',
  md: 'markdown',
  markdown: 'markdown',
  csv: 'csv',
  tsv: 'csv',
  json: 'json',
  yaml: 'json',
  yml: 'json',
  toml: 'json',
  docx: 'doc',
  doc: 'doc',
  xlsx: 'sheet',
  xls: 'sheet',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  flac: 'audio',
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  webm: 'video',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  '7z': 'archive',
  txt: 'text',
  log: 'text',
};

/**
 * Per-type chip colors.  Each entry returns `{ fg, bg, border }` already
 * adjusted to look readable on the米色 panel and米色 timeline tooltip.
 */
export const TYPE_COLOR: Record<AttachmentType, { fg: string; bg: string; border: string }> = {
  pdf:      { fg: '#A04A2F', bg: 'rgba(201, 100, 66, 0.14)', border: 'rgba(201, 100, 66, 0.32)' },
  image:    { fg: '#5E8047', bg: 'rgba(122, 158, 88,  0.14)', border: 'rgba(122, 158, 88,  0.30)' },
  code:     { fg: '#7B5B26', bg: 'rgba(168, 124, 60,  0.16)', border: 'rgba(168, 124, 60,  0.32)' },
  markdown: { fg: '#3A6B8B', bg: 'rgba(95, 134, 168, 0.14)', border: 'rgba(95, 134, 168, 0.30)' },
  csv:      { fg: '#7B4E8C', bg: 'rgba(140, 96, 156, 0.14)', border: 'rgba(140, 96, 156, 0.30)' },
  json:     { fg: '#6B5D24', bg: 'rgba(165, 144, 64,  0.16)', border: 'rgba(165, 144, 64,  0.32)' },
  doc:      { fg: '#3D5A8F', bg: 'rgba(85, 116, 168, 0.14)', border: 'rgba(85, 116, 168, 0.30)' },
  sheet:    { fg: '#2F6B3A', bg: 'rgba(70, 138, 90,   0.14)', border: 'rgba(70, 138, 90,   0.30)' },
  audio:    { fg: '#7A4C6C', bg: 'rgba(154, 90, 130,  0.14)', border: 'rgba(154, 90, 130,  0.30)' },
  video:    { fg: '#7A3A2F', bg: 'rgba(174, 88, 70,   0.14)', border: 'rgba(174, 88, 70,   0.30)' },
  archive:  { fg: '#5C5040', bg: 'rgba(125, 110, 90,  0.16)', border: 'rgba(125, 110, 90,  0.32)' },
  text:     { fg: '#6E5A40', bg: 'rgba(155, 130, 90,  0.14)', border: 'rgba(155, 130, 90,  0.28)' },
  other:    { fg: '#5A4634', bg: 'rgba(120, 92, 68,   0.14)', border: 'rgba(120, 92, 68,   0.28)' },
};

export const TYPE_LABEL: Record<AttachmentType, string> = {
  pdf: 'PDF',
  image: 'IMG',
  code: 'CODE',
  markdown: 'MD',
  csv: 'CSV',
  json: 'JSON',
  doc: 'DOC',
  sheet: 'XLS',
  audio: 'AUDIO',
  video: 'VIDEO',
  archive: 'ZIP',
  text: 'TXT',
  other: 'FILE',
};

function detectTypeFromName(name: string): AttachmentType {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return TYPE_BY_EXT[ext] || 'other';
}

/**
 * Regex used to recognise a `data-testid` value that's literally a filename
 * (e.g. `writing-rubrics.pdf`, `难题1.png`, `5月20日 (1).mp3`).  Allows
 * unicode (Chinese filenames are common), spaces and parens.  The set of
 * extensions is the union of TYPE_BY_EXT plus a handful Claude renders
 * thumbnails for but our type-map calls "other".
 */
const FILENAME_TESTID_RE =
  /\.(pdf|png|jpe?g|gif|webp|svg|md|markdown|csv|tsv|json|yaml|yml|toml|docx?|pptx?|xlsx?|mp[34]|wav|m4a|flac|mov|avi|mkv|webm|zip|7z|tar|gz|py|js|ts|tsx|jsx|java|cpp|c|h|rs|go|rb|php|sh|txt|log|html?)$/i;

/**
 * Scan a user-message render wrapper for attachment markers and extract
 * `{ type, label, name }` for each one.
 *
 * Claude renders attachments in 3 distinct DOM shapes:
 *
 *   **Pattern A** — preview-able file (PDF, image with thumbnail):
 *     `<div data-testid="writing-rubrics.pdf">`
 *       `<img alt="writing-rubrics.pdf">`
 *       `<p class="uppercase">pdf</p>`  // sometimes
 *     - filename in `data-testid`, label in `p.uppercase` (else from ext)
 *
 *   **Pattern B** — pure image with no badge (PNG/JPG):
 *     `<div data-testid="cat.png">`
 *       `<img alt="cat.png" src=".../preview">`
 *     - same as A but no `<p>` — label derived from extension
 *
 *   **Pattern C** — generic file thumbnail card (MP3, SVG, pasted text):
 *     `<div data-testid="file-thumbnail">`
 *       `<h3>5月20日 (1).mp3</h3>`           // filename, or absent for pasted-text
 *       `<button aria-label="Pasted Text, pasted, 100 lines">`  // pasted-text variant
 *       `<p class="uppercase">mp3</p>`       // label (or "pasted")
 *     - filename in `<h3>` (or aria-label for pasted), label in `p.uppercase`
 *
 * Attachments live as SIBLINGS of `[data-testid="user-message"]`, all
 * inside the same `[data-test-render-count]` wrapper we already scan.
 */
export function detectAttachments(wrapper: Element): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];

  // ----- Pattern A + B: named-testid files (filename = testid value) -----
  // Walk every [data-testid] child whose value looks like a filename.
  for (const el of Array.from(wrapper.querySelectorAll<HTMLElement>('[data-testid]'))) {
    const tid = el.getAttribute('data-testid') || '';
    if (!tid) continue;
    if (!FILENAME_TESTID_RE.test(tid)) continue;
    const name = tid;
    const type = detectTypeFromName(name);
    // Claude's badge uses CSS `text-transform: uppercase` but textContent
    // returns the raw lowercase string — uppercase it ourselves so it
    // visually matches our TYPE_LABEL fallback (PDF, IMG, AUDIO …).
    const rawLabel =
      el.querySelector('p[class*="uppercase"]')?.textContent?.trim() || TYPE_LABEL[type];
    const label = rawLabel.toUpperCase();
    out.push({ type, label, name });
  }

  // ----- Pattern C: data-testid="file-thumbnail" generic card -----
  for (const el of Array.from(
    wrapper.querySelectorAll<HTMLElement>('[data-testid="file-thumbnail"]'),
  )) {
    // Pasted-text variant — `aria-label="Pasted Text, pasted, N lines"` on
    // the inner button.  Keep our Chinese chip label format.
    const pastedBtn = el.querySelector<HTMLButtonElement>(
      'button[aria-label^="Pasted "]',
    );
    if (pastedBtn) {
      const al = pastedBtn.getAttribute('aria-label') || '';
      const m = al.match(/^Pasted Text,\s*pasted,\s*(\d+)\s*lines?$/i);
      if (m) {
        const txt = (pastedBtn.textContent || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 24);
        out.push({
          type: 'text',
          label: `TXT · ${m[1]}行`,
          name: txt || '粘贴文本',
        });
        continue;
      }
    }
    // Real file thumbnail — filename in `<h3>`, label in `<p class="uppercase">`
    const h3 = el.querySelector('h3');
    const name = (h3?.textContent || '').trim();
    if (!name) continue;          // Loading placeholder — skip
    const type = detectTypeFromName(name);
    // Claude's badge uses CSS `text-transform: uppercase` but textContent
    // returns the raw lowercase string — uppercase it ourselves so it
    // visually matches our TYPE_LABEL fallback (PDF, IMG, AUDIO …).
    const rawLabel =
      el.querySelector('p[class*="uppercase"]')?.textContent?.trim() || TYPE_LABEL[type];
    const label = rawLabel.toUpperCase();
    out.push({ type, label, name });
  }

  // ----- Legacy: aria-label-based pasted text (older Claude builds) -----
  // Keep as a safety net in case Claude's React tree omits the
  // file-thumbnail wrapper around a Pasted-Text button.
  for (const btn of Array.from(
    wrapper.querySelectorAll<HTMLButtonElement>('button[aria-label^="Pasted "]'),
  )) {
    if (btn.closest('[data-testid="file-thumbnail"]')) continue;  // already handled above
    const al = btn.getAttribute('aria-label') || '';
    const m = al.match(/^Pasted Text,\s*pasted,\s*(\d+)\s*lines?$/i);
    if (!m) continue;
    const txt = (btn.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    out.push({
      type: 'text',
      label: `TXT · ${m[1]}行`,
      name: txt || '粘贴文本',
    });
  }

  // De-dupe by (type, name) — Claude sometimes mounts the same attachment
  // twice in different containers during streaming reconciliation.
  const seen = new Set<string>();
  return out.filter((a) => {
    const k = `${a.type}:${a.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
