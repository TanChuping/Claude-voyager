/**
 * TimelinePreviewPanel — Claude-Voyager port of GPT-Voyager's
 * `timeline/TimelinePreviewPanel.ts`.
 *
 * A 320-px floating panel anchored to the timeline bar, showing all turns of
 * the current conversation as a vertical list:  index · star toggle ·
 * truncated text · timestamp (when starred).  Search box at top filters by
 * substring with 200 ms debounce.  Click a row → scroll the conversation to
 * that turn and lock it active.  Click outside / Escape closes (unless
 * pinned).
 *
 * Design from GPT-Voyager; implementation is a fresh re-write in vanilla TS
 * with Claude-themed colors so it integrates with TimelineV2.
 */
import type { StarredMessage } from '../timeline/starredTypes';
import { StarredMessagesService } from '../timeline/StarredMessagesService';
import { TYPE_COLOR, type AttachmentType } from './attachments';

const PANEL_W = 320;
const ROW_TEXT_MAX = 90;
const SEARCH_DEBOUNCE_MS = 180;

const PAL = {
  bg: '#FBF7EF',
  text: '#3D2A1F',
  textMuted: 'rgba(91, 50, 32, 0.55)',
  border: '#E8DDC9',
  accent: '#C96442',
  accentSoft: 'rgba(201, 100, 66, 0.10)',
  accentHover: 'rgba(201, 100, 66, 0.18)',
  star: '#C96442',
  starIdle: 'rgba(91, 50, 32, 0.35)',
  highlight: 'rgba(232, 168, 124, 0.55)',
} as const;

const SVG_STAR_OUTLINE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" width="14" height="14"><path d="M12 2.7l2.7 6.45 6.95.55-5.3 4.55 1.65 6.8L12 17.4 5.4 21.05l1.65-6.8L1.75 9.7l6.95-.55L12 2.7z"/></svg>`;
const SVG_STAR_FILLED = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2.7l2.7 6.45 6.95.55-5.3 4.55 1.65 6.8L12 17.4 5.4 21.05l1.65-6.8L1.75 9.7l6.95-.55L12 2.7z"/></svg>`;

export type PreviewRow = {
  id: string;
  index: number;          // 0-based, displayed as index+1
  text: string;           // full text (may be > ROW_TEXT_MAX, we truncate ourselves)
  starred: boolean;
  attachments?: { type: AttachmentType; label: string; name: string }[];
};

export type PreviewPanelArgs = {
  /** Anchor element — usually the cv-tl-bar. We position relative to it. */
  anchor: HTMLElement;
  /** Click handler — caller scrolls the conversation. */
  onNavigate: (row: PreviewRow) => void;
  /** Star toggle — caller persists + refreshes timeline dots. */
  onToggleStar: (row: PreviewRow) => Promise<void> | void;
  /** Return the current row list (called whenever the panel re-renders). */
  getRows: () => PreviewRow[];
  /** Currently-active turn id, drives the highlight. */
  getActiveId: () => string | null;
};

export type PreviewPanelHandle = {
  toggle: () => void;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  refresh: () => void;
  destroy: () => void;
};

export function mountTimelinePreviewPanel(args: PreviewPanelArgs): PreviewPanelHandle {
  const panel = document.createElement('div');
  panel.className = 'cv-tl-preview-panel';
  panel.style.cssText = [
    'position: fixed',
    `width: ${PANEL_W}px`,
    'max-height: 70vh',
    `background: ${PAL.bg}`,
    `border: 1px solid ${PAL.border}`,
    'border-radius: 14px',
    'box-shadow: 0 12px 36px rgba(91, 50, 32, 0.22), 0 0 0 1px rgba(91, 50, 32, 0.04)',
    'z-index: 2147483645',
    'display: flex',
    'flex-direction: column',
    'opacity: 0',
    'transform: scale(0.96) translateX(8px)',
    'pointer-events: none',
    'overflow: hidden',
    'transition: opacity 140ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1)',
    `color: ${PAL.text}`,
    'font: 500 13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
  ].join('; ');

  // Header — title + close
  const header = document.createElement('div');
  header.style.cssText = [
    'display: flex',
    'align-items: center',
    'justify-content: space-between',
    'padding: 10px 12px 4px',
    `color: ${PAL.text}`,
  ].join('; ');
  const titleEl = document.createElement('div');
  titleEl.textContent = '对话目录';
  titleEl.style.cssText = 'font-weight: 700; font-size: 14px;';
  const countEl = document.createElement('span');
  countEl.style.cssText = `color: ${PAL.textMuted}; font-size: 12px; font-weight: 500;`;
  header.appendChild(titleEl);
  header.appendChild(countEl);
  panel.appendChild(header);

  // Search row
  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'padding: 4px 12px 8px;';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索消息 / Search…';
  searchInput.style.cssText = [
    'width: 100%',
    'box-sizing: border-box',
    `border: 1px solid ${PAL.border}`,
    'border-radius: 8px',
    'padding: 6px 10px',
    'font-size: 12.5px',
    'background: transparent',
    `color: ${PAL.text}`,
    'outline: none',
    'transition: border-color 150ms ease',
  ].join('; ');
  searchInput.addEventListener('focus', () => {
    searchInput.style.borderColor = PAL.accent;
  });
  searchInput.addEventListener('blur', () => {
    searchInput.style.borderColor = PAL.border;
  });
  searchWrap.appendChild(searchInput);
  panel.appendChild(searchWrap);

  // List
  const list = document.createElement('div');
  list.style.cssText = [
    'flex: 1 1 auto',
    'overflow-y: auto',
    'overflow-x: hidden',
    'padding: 2px 0 8px',
    'min-height: 0',
  ].join('; ');
  panel.appendChild(list);

  // Stop wheel propagation (panel scroll isolation)
  list.addEventListener(
    'wheel',
    (e) => {
      const atTop = list.scrollTop === 0 && e.deltaY < 0;
      const atBottom =
        Math.ceil(list.scrollTop + list.clientHeight) >= list.scrollHeight && e.deltaY > 0;
      if (atTop || atBottom) e.preventDefault();
      e.stopPropagation();
    },
    { passive: false },
  );

  document.body.appendChild(panel);

  let isOpen = false;
  let searchQuery = '';
  let searchTimer = 0;

  function truncate(s: string, n: number): string {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    return `${t.slice(0, n).trimEnd()}…`;
  }

  function highlightMatch(text: string, query: string): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (!query) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    const q = query.toLowerCase();
    const lower = text.toLowerCase();
    let cursor = 0;
    let idx = lower.indexOf(q, cursor);
    while (idx !== -1) {
      if (idx > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, idx)));
      const mark = document.createElement('mark');
      mark.style.cssText = `background: ${PAL.highlight}; color: inherit; border-radius: 2px; padding: 0 1px;`;
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      cursor = idx + q.length;
      idx = lower.indexOf(q, cursor);
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    return frag;
  }

  function buildRow(row: PreviewRow, activeId: string | null): HTMLDivElement {
    const item = document.createElement('div');
    item.dataset.turnId = row.id;
    const active = row.id === activeId;
    item.style.cssText = [
      'display: flex',
      'align-items: flex-start',
      'gap: 8px',
      'padding: 7px 10px 7px 9px',
      'cursor: pointer',
      'border-left: 3px solid transparent',
      'transition: background-color 100ms ease',
      `color: ${PAL.text}`,
    ].join('; ');
    if (active) {
      item.style.borderLeftColor = PAL.accent;
      item.style.background = PAL.accentSoft;
    }

    // Star button
    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    starBtn.title = row.starred ? '取消收藏' : '收藏此消息';
    starBtn.style.cssText = [
      'flex: 0 0 auto',
      'width: 22px',
      'height: 22px',
      'border-radius: 5px',
      'border: none',
      'padding: 0',
      'cursor: pointer',
      `color: ${row.starred ? PAL.star : PAL.starIdle}`,
      'background: transparent',
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'transition: background-color 120ms ease, color 120ms ease, transform 120ms ease',
      'margin-top: 1px',
    ].join('; ');
    starBtn.innerHTML = row.starred ? SVG_STAR_FILLED : SVG_STAR_OUTLINE;
    starBtn.addEventListener('mouseenter', () => {
      starBtn.style.background = 'rgba(201, 100, 66, 0.12)';
      starBtn.style.color = PAL.star;
    });
    starBtn.addEventListener('mouseleave', () => {
      starBtn.style.background = 'transparent';
      starBtn.style.color = row.starred ? PAL.star : PAL.starIdle;
    });
    starBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await args.onToggleStar(row);
      // Optimistic re-render
      requestAnimationFrame(() => renderList());
    });

    // Index number
    const indexEl = document.createElement('span');
    indexEl.textContent = String(row.index + 1);
    indexEl.style.cssText = [
      'flex: 0 0 auto',
      'min-width: 18px',
      `color: ${PAL.textMuted}`,
      'font: 600 11px/22px ui-monospace, "SF Mono", Menlo, monospace',
      'text-align: right',
      'user-select: none',
    ].join('; ');

    // Text body — single line, ellipsis
    const textEl = document.createElement('div');
    textEl.style.cssText = [
      'flex: 1 1 auto',
      'min-width: 0',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'display: -webkit-box',
      '-webkit-line-clamp: 2',
      '-webkit-box-orient: vertical',
      'word-break: break-word',
      'font-size: 12.5px',
      'line-height: 1.45',
    ].join('; ');
    const truncated = truncate(row.text || '(空消息 / empty)', ROW_TEXT_MAX);
    textEl.appendChild(highlightMatch(truncated, searchQuery));

    // Attachments — one colored rounded-rect chip per file, max 3 inline.
    if (row.attachments && row.attachments.length) {
      const chipRow = document.createElement('div');
      chipRow.style.cssText = [
        'display: flex',
        'flex-wrap: wrap',
        'gap: 3px',
        'margin-top: 3px',
      ].join('; ');
      for (const att of row.attachments.slice(0, 3)) {
        const c = TYPE_COLOR[att.type];
        const chip = document.createElement('span');
        chip.style.cssText = [
          'display: inline-flex',
          'align-items: center',
          'gap: 3px',
          'padding: 1px 6px 2px',
          'border-radius: 5px',
          'font: 600 10px/1.4 ui-monospace, "SF Mono", Menlo, monospace',
          `color: ${c.fg}`,
          `background: ${c.bg}`,
          `border: 1px solid ${c.border}`,
          'max-width: 180px',
        ].join('; ');
        const lab = document.createElement('span');
        lab.textContent = att.label;
        lab.style.cssText = 'font-weight: 700; letter-spacing: 0.03em;';
        const sep = document.createElement('span');
        sep.textContent = '·';
        sep.style.cssText = 'opacity: 0.55;';
        const nm = document.createElement('span');
        nm.textContent = att.name;
        nm.style.cssText = 'font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px;';
        chip.appendChild(lab);
        chip.appendChild(sep);
        chip.appendChild(nm);
        chipRow.appendChild(chip);
      }
      if (row.attachments.length > 3) {
        const more = document.createElement('span');
        more.textContent = `+${row.attachments.length - 3}`;
        more.style.cssText = `color: ${PAL.textMuted}; font: 600 10px/1.4 ui-monospace; align-self: center;`;
        chipRow.appendChild(more);
      }
      textEl.appendChild(chipRow);
    }

    item.appendChild(starBtn);
    item.appendChild(indexEl);
    item.appendChild(textEl);

    // Row click → navigate
    item.addEventListener('mouseenter', () => {
      if (item.style.background !== PAL.accentSoft) {
        item.style.background = PAL.accentHover;
      }
    });
    item.addEventListener('mouseleave', () => {
      item.style.background = active ? PAL.accentSoft : 'transparent';
    });
    item.addEventListener('click', () => {
      args.onNavigate(row);
      // Re-render to update the active highlight immediately
      requestAnimationFrame(() => renderList());
    });

    return item;
  }

  function renderList(): void {
    const all = args.getRows();
    countEl.textContent = `${all.length} 条`;
    const q = searchQuery.trim().toLowerCase();
    const rows = q
      ? all.filter((r) => (r.text || '').toLowerCase().includes(q))
      : all;
    const activeId = args.getActiveId();
    list.innerHTML = '';
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = q ? `未找到包含 "${searchQuery}" 的消息` : '当前对话没有消息';
      empty.style.cssText = `padding: 20px; text-align: center; color: ${PAL.textMuted}; font-size: 12.5px;`;
      list.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of rows) frag.appendChild(buildRow(row, activeId));
    list.appendChild(frag);

    // Scroll active row into view
    if (activeId) {
      const activeItem = list.querySelector(`[data-turn-id="${activeId}"]`) as HTMLElement | null;
      activeItem?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }

  function positionPanel(): void {
    if (!isOpen) return;
    const r = args.anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Default: place to the LEFT of the bar
    const desiredRight = vw - r.left + 8; // distance from viewport right edge
    const right = Math.max(8, Math.min(vw - PANEL_W - 8, desiredRight));
    panel.style.right = `${right}px`;
    panel.style.left = 'auto';
    // Vertically: center on the bar, but clamp inside viewport
    const ph = Math.min(panel.scrollHeight || 320, vh * 0.7);
    const center = (r.top + r.bottom) / 2;
    const top = Math.max(8, Math.min(vh - ph - 8, center - ph / 2));
    panel.style.top = `${top}px`;
  }

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    searchQuery = '';
    searchInput.value = '';
    renderList();
    positionPanel();
    panel.style.opacity = '1';
    panel.style.transform = 'scale(1) translateX(0)';
    panel.style.pointerEvents = 'auto';
    document.addEventListener('pointerdown', onOutsideClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', positionPanel);
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    panel.style.opacity = '0';
    panel.style.transform = 'scale(0.96) translateX(8px)';
    panel.style.pointerEvents = 'none';
    document.removeEventListener('pointerdown', onOutsideClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', positionPanel);
  }

  function toggle(): void {
    if (isOpen) close();
    else open();
  }

  function onOutsideClick(e: PointerEvent): void {
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (panel.contains(t)) return;
    // Clicks on the hamburger button itself shouldn't close — handled there
    if ((t as Element).closest?.('.cv-tl-fav-btn')) return;
    close();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }

  // Search input
  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchQuery = searchInput.value;
      renderList();
    }, SEARCH_DEBOUNCE_MS);
  });

  return {
    toggle,
    open,
    close,
    isOpen: () => isOpen,
    refresh: renderList,
    destroy: () => {
      close();
      panel.remove();
    },
  };
}
