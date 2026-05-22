# Claude-Voyager

Claude-Voyager is a GPL-3.0 browser extension that adapts the Voyager-style chat workflow to [Claude.ai](https://claude.ai). It brings the timeline navigation, text pins, folders, favorites, prompt vault, and one-click conversation export from the ChatGPT version over to Anthropic's Claude.

It is a heavily modified work based on [ChatGPT Voyager](https://github.com/TanChuping/chatgpt-voyager) (which is itself based on [Gemini Voyager](https://github.com/Nagi-ovo/gemini-voyager)). Respect and thanks to the original authors and contributors for the foundation, ideas, and GPL-3.0 licensed work that made this project possible. Claude DOM probing and the integrated folder sidebar pattern were validated against [claude-nexus](https://github.com/Qiuner/claude-nexus) (MIT) — see `THIRD_PARTY_NOTICES.md`.

Repository: [TanChuping/Claude-voyager](https://github.com/TanChuping/Claude-voyager)

## Features

- **Timeline with dot navigation** along the right edge of the conversation. Each dot is a user turn; click to smooth-scroll to it, hover for the message preview, file-type pills sit horizontally to the left of the dot.
- **Text pins inside long answers** — click the 📌 button at the bottom-right of the timeline bar, then click any spot inside a message to drop a text pin. Step between pins on the active message with ▲ / ▼, click a badge to select, click the inline trash to delete. Pins persist per-conversation in localStorage.
- **Per-conversation table of contents** behind the hamburger button — a 320-px floating panel with search, per-row star toggle, attachment chips, and click-to-jump.
- **Favorites that survive conversation switches** — star any user message via the timeline preview panel or the timeline hover toolbar. The favorites popover (in the prompt manager footer or in the floating folder panel's ★ button) lists every starred message across every Claude conversation. Click a row in the current conversation to jump in-page; click a row in a different conversation to get a warning dialog, then it navigates and lands you on the right turn.
- **Cross-session jump robustness** — Claude's internal `data-test-render-count` increments across reloads, which used to silently break "click → jump" for any star created in a previous session. Stars now also store the message text preview; on jump, the timeline resolves turn ID first, then falls back to text-content match, then to a positional heuristic.
- **Pure-attachment messages** (user uploaded files without typing) get a dot too, with `📎 file1 · file2` as their tooltip text and per-type colored capsules.
- **Attachment type detection** for PDF, image (PNG/JPG/etc.), MP3/MP4/WAV, SVG, DOCX/XLSX, code files, CSV/JSON, markdown, archives, pasted-text. Each gets a distinct color and uppercase 3–4 letter chip (`PDF·report.pdf`, `IMG·diagram.png`, `MP3·talk.mp3`, …).
- **Sidebar folders** for organizing conversations locally (mounted inside Claude's native sidebar at the top, above Recents).
- **Floating folder panel** as an alternative to the sidebar — toggle it from the popup. The panel header carries a ★ button that opens the favorites popover.
- **Prompt Manager** with tags, search, prompt import/export, compact/comfortable display modes, click-to-copy or click-to-insert behavior, and an in-footer favorites popover.
- **One-click single-conversation export** from a new button in the Claude top bar next to the native Share control. Output is Markdown or JSON. Format choice lives in the extension popup.
- **Silent API cache primer** — a page-world fetch hook (runs in MAIN world via a dedicated content script at `document_start`) listens for Claude's own `/api/organizations/<org>/chat_conversations/<conv>` calls and bridges the parsed payload into the extension via `window.postMessage` + a sessionStorage fallback. Effect: opening a long conversation immediately has dot tooltips and preview-panel rows ready, without waiting for the user to scroll past each turn.
- **Streaming-robust dot updates** — mutation filter rejects mutations that don't touch the user-turn set, 120 ms debounce coalesces stream churn, and an ID-signature early exit skips the dot DOM rebuild when nothing actually moved. 100 character-level mutations during a streaming response trigger 0 dot rebuilds in the test harness.
- **Layout controls** for chat font size and code font size (80–150 % of base).
- **All data stays local** — no remote sync, no analytics, no remote code loading.

## Install Locally

Requirements:

- Bun 1.0 or newer (or Node.js 20+ with `npm`; the scripts use `bun` but `npm run build:chrome` also works after `npm install`).
- Chrome, Edge, or any Chromium-based browser with Developer Mode enabled.

Install dependencies:

```bash
bun install
```

Build the Chrome/Edge extension:

```bash
bun run build:chrome
```

Load the unpacked extension:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer Mode.
3. Click `Load unpacked`.
4. Select the generated `dist_chrome` folder.
5. Open or refresh `https://claude.ai`.

During development, rebuild after code changes and refresh the unpacked extension from the browser extensions page. There's a small CLAUDE.md in the repo root with notes on driving the extension end-to-end via [browser-harness](https://github.com/anthropics/browser-harness) for fast iteration.

## Common Commands

```bash
bun run typecheck
bun run test
bun run build:chrome
```

Other platform build scripts (`build:firefox`, `build:safari`) are kept from the upstream project, but the actively maintained target for this fork is Chrome/Edge on Claude.ai.

## Recent Updates

### 1.0.0

- **First public release for Claude.ai.** Forked from ChatGPT Voyager 1.6.x, all ChatGPT-specific DOM selectors, API endpoints, and storage keys rewritten for Claude:
  - URL scheme: `/chat/<uuid>` (Claude) instead of `/c/<uuid>` (ChatGPT).
  - Scroll container: `[data-autoscroll-container="true"]` with persistent body-level watcher so the timeline re-attaches when Claude re-mounts the container on conversation switch.
  - Message wrapper: `[data-test-render-count]` containing `[data-testid="user-message"]` (or attachment markers for pure-file turns).
  - API: `GET /api/organizations/<org>/chat_conversations/<conv>?tree=True&rendering_mode=messages&render_all_tools=true`, with a linear `chat_messages` array walked from `current_leaf_message_uuid` via `parent_message_uuid` to get the currently-rendered chain.
  - Storage keys: `gpt*` → `claude*`, `gv*` → `cv*` prefixes.
- **Theme** repainted to 米色 + Claude orange — `#C96442` (deep orange) for active dots and pin badges, `#E8A87C` (light orange) for idle dots, `#F5EFE3` 米色 for the timeline bar background, traditional `#F4C430` gold for the star icon.
- **Text-pin feature** ported from GPT-Voyager — cluster of three buttons (▲ prev / 📌 toggle / ▼ next) anchored to the bottom of the timeline bar. Pin mode flips body cursor to crosshair, the next click on any message text drops a pin there; prev/next steps through pins on the active message; click badge → inline trash to delete.
- **Favorites flow** with cross-conversation warning dialog, content-based fallback resolver (handles render-count drift across sessions), and silent background refresh (star/unstar no longer auto-pops the favorites panel).
- **Attachment detection** rewritten for Claude's three DOM patterns: `data-testid="<filename>.<ext>"` (PDF + image with preview), the same shape without a badge (pure-image), and `data-testid="file-thumbnail"` with filename in `<h3>` and label in `<p class="uppercase">`. Pure-attachment messages (no typed text) now create a dot too.
- **Dot-update robustness layer** — 120 ms mutation debounce + a mutation filter that rejects anything not touching the user-turn set + ID-signature early-exit before the dot DOM rebuild. Long streaming responses no longer churn the timeline at 60 fps.

## Privacy Notes

Claude-Voyager stores its feature data in the browser extension storage on the user's machine. It does not ship account sync, remote analytics, or remote code loading. The page-world conversation cache primer only reads Claude's *own* outgoing API responses (passively, via fetch wrapping) — it never originates new network requests.

## License And Attribution

This project is distributed under GPL-3.0, following the original license of Gemini Voyager and ChatGPT Voyager.

- Original project: [Gemini Voyager](https://github.com/Nagi-ovo/gemini-voyager) (Jonathan Braat)
- Upstream fork: [ChatGPT Voyager](https://github.com/TanChuping/chatgpt-voyager) (Jesse Zhang / TanChuping)
- This project: [Claude-Voyager](https://github.com/TanChuping/Claude-voyager)
- Claude DOM reference: [claude-nexus](https://github.com/Qiuner/claude-nexus) (MIT) — see `THIRD_PARTY_NOTICES.md`

If you redistribute modified versions, keep the GPL-3.0 license and preserve attribution to the upstream projects.
