# Claude-Voyager — Working Notes for Agents

This file teaches future agents (including future-me) how to work on this project
**without re-discovering the same hard lessons every session**.

---

## 🚨 Browser verification — engrave this into instinct

We are building a Chrome extension that runs on `https://claude.ai/`. To verify
ANY change, you need to inspect the live page. **Always use `browser-harness`.**
The skill is installed; just call it.

### Rule 1: Inspect via `js(...)`, NOT screenshots

Screenshots tell you almost nothing. The page has 29 messages, the timeline is
1.5rem wide and lives in `position: fixed` at the right edge — a screenshot
won't tell you if `.gpt-timeline-bar` has 1 dot or 29 dots, or whether the
ROUTE detection ran.

Prefer:

```bash
browser-harness -c "
result = js('''
  return {
    fab: !!document.querySelector('.gv-floating-fab'),
    timelineBar: !!document.querySelector('.gpt-timeline-bar'),
    dotCount: document.querySelectorAll('.timeline-dot, [class*=\"timeline-dot\"]').length,
    folderRoot: !!document.querySelector('.gv-folder-container'),
    promptTrigger: !!document.querySelector('#gv-pm-trigger'),
    allGvCount: document.querySelectorAll('[class*=\"gv-\"]').length,
    bodyKidClasses: Array.from(document.body.children).map(c => (c.className?.toString?.() || c.tagName + '#' + c.id).substring(0,80))
  };
''')
import json
print(json.dumps(result, indent=2, ensure_ascii=False))
"
```

Screenshot is a **last resort** for true visual issues (color, layout
misalignment). For state, behavior, presence/absence — always `js(...)`.

### Rule 2: Use `browser-harness -c '...'` one-liners

Helpers (`js`, `new_tab`, `cdp`, `click_at_xy`, `capture_screenshot`,
`list_tabs`, `wait_for_load`, `page_info`, `drain_events`, `press_key`,
`type_text`, `scroll`, `switch_tab`, `ensure_real_tab`) are auto-imported.
**Don't write `import sys; sys.path.insert(0, ...)` ceremonies** — that's the
wrong way to invoke the skill.

Right:
```bash
browser-harness -c "
new_tab('https://claude.ai/chat/...')
import time; time.sleep(8)
print(js('return document.querySelectorAll(\".gv-folder-empty\").length'))
"
```

### Rule 3: Use Accessibility tree to find UI controls on chrome://

The `chrome://extensions` page disables `js()` for security, but
`cdp('Accessibility.getFullAXTree', {})` works. Find buttons by `name` field:

```bash
browser-harness -c "
new_tab('chrome://extensions/')
import time; time.sleep(1.5)
cdp('Accessibility.enable', {})
cdp('DOM.enable', {})
nodes = cdp('Accessibility.getFullAXTree', {}).get('nodes', [])
for n in nodes:
    role = (n.get('role') or {}).get('value','')
    name = (n.get('name') or {}).get('value','')
    desc = (n.get('description') or {}).get('value','')
    if role == 'button' and name == '重新加载' and 'Claude-Voyager' in desc:
        bid = n.get('backendDOMNodeId')
        box = cdp('DOM.getBoxModel', backendNodeId=bid).get('model', {})
        c = box.get('content', [])
        if len(c) >= 8:
            click_at_xy((c[0]+c[4])/2, (c[1]+c[5])/2)
            print('clicked reload')
            break
"
```

After every code change that affects the bundle:
1. `bun run build:chrome`
2. Click reload button on `chrome://extensions/` for **Claude-Voyager**
3. Close all `claude.ai/chat/` tabs, open fresh one (`new_tab(url)`)
4. Wait 8–10 s for content script to mount
5. Inspect with `js(...)`

### Rule 4: Don't sleep-and-pray when fetching captured data

`drain_events()` returns recent CDP events. For Runtime/Console events to
fire, run `cdp('Runtime.enable', {})` and `cdp('Console.enable', {})` BEFORE
the page action you want to capture. The harness doesn't auto-enable these.

For content-script-world exceptions, attach via
`cdp('Target.attachToTarget', targetId=..., flatten=True)` and re-enable
Runtime in that session.

### Rule 5: Tab hygiene — close old tabs as you go

`new_tab(url)` opens a fresh Chrome tab every time. After a long debugging
session you can easily end up with 20+ tabs across `chrome://extensions/`,
`chrome-extension://<id>/popup`, multiple `claude.ai/new?incognito=` and
old `claude.ai/chat/<uuid>` pages — each one runs the content script and
holds React state. On the user's machine this slows the whole browser
down to a crawl.

Practice:
- Before opening yet another tab for the same purpose (extension reload,
  popup probe, fresh incognito chat), close the old one with
  `close_tab(targetId)`.
- Every ~5 tabs spawned, sweep with `list_tabs()` and close anything
  that's no longer in active use — keep at most one `chrome://extensions/`,
  one extension-page tab, and one Claude tab.
- Never close the user's own tabs (any tab whose URL doesn't match a
  pattern you opened). Filter by `claude.ai/new?incognito=` and
  `chrome://` / `chrome-extension://` to stay safe.

```python
# After finishing a probe round, close stale tabs of your own.
for tab in list_tabs():
    url = tab.get('url', '')
    if url.startswith('chrome://extensions') and tab['targetId'] != keep:
        close_tab(tab['targetId'])
```

---

## 🟧 Project conventions

### Branding
- Display name: **Claude-Voyager** (not "GPT-Voyager" — check `src/locales/`,
  `package.json`, console.warn/error strings, `roleHeading` in exporters).
- Storage keys: `claude*` prefix (was `gpt*`), `cv*` prefix (was `gv*`).
  - CSS class names stay `gv-*` for now (internal namespace marker).

### Color palette (米色 + Claude 橘)
Defined as CSS variables at the top of `public/contentStyle.css`. All hex
purples (`#6d28d9`, `#a78bfa`, `#7c3aed`, etc.) and `rgba(139,92,246,*)` etc.
must be replaced. Use:
- `#C96442` — Claude 深橘 (primary, active dots, pin)
- `#E8A87C` — Claude 浅橘 (idle dots)
- `#F5EFE3` — 米色 (timeline bar bg)
- `rgba(91,50,32,*)` — 暖深 (shadows, was deep purple)
- `rgba(232,168,124,*)` — 浅橘 alpha
- `rgba(201,100,66,*)` — 深橘 alpha

When you see a purple `#`-hex or rgba in any file, **fix it on the spot** —
don't leave it for a "polish later" pass.

### "When stuck, copy from claude-nexus"
`D:\coding\claude-nexus-ref\` is a working Claude extension. When porting a
feature from GPT-Voyager fails because of ChatGPT-specific DOM/API
assumptions, **steal the implementation from claude-nexus first** — get it
working — THEN integrate our own features (favorites/pin, export, dot
tooltips, smooth scroll) on top.

Key claude-nexus files we've referenced:
- `src/pages/content/components/Timeline/index.tsx` — 76-line timeline UI
- `src/pages/content/hooks/useTimeline.ts` — scroll/sync hook
- `src/constants/selectors.ts` — Claude DOM selectors

### Claude DOM (verified by browser-harness)
- URL: `/chat/<uuid>` (NOT `/c/`)
- Sidebar: `nav[aria-label="Sidebar"]` containing `ul.flex.flex-col.gap-px`
- Conversation link: `a[href^="/chat/"]`
- Scroll container: `[data-autoscroll-container="true"]` (or its inner
  `[scrollbar-gutter:stable]` div)
- Message wrapper: `[data-test-render-count]`
- User message: `[data-testid="user-message"]`
  - Bubble parent: `[data-user-message-bubble="true"]`
- Assistant message: `.font-claude-response` or `[data-is-streaming]`
- Toolbar copy: `button[data-testid="action-bar-copy"]`

### Claude API (verified)
- Endpoint: `GET /api/organizations/<org_uuid>/chat_conversations/<conv_uuid>?tree=True&rendering_mode=messages&render_all_tools=true`
- Top-level shape: `{ uuid, name, summary, model, created_at, updated_at,
  current_leaf_message_uuid, chat_messages: [...] }`
- Each chat_message: `{ uuid, content: [{type, text, ...}, ...],
  sender: 'human'|'assistant', created_at, parent_message_uuid, attachments }`
- Walk: from `current_leaf_message_uuid` reverse via `parent_message_uuid` for
  the currently-rendered chain. Linear array (not a DAG like ChatGPT).

### Build / install
```bash
bun install
bun run build:chrome    # → dist_chrome/
```
Extension key is fixed via `manifest.json#key` → ID
`nbdckmogmgoagkhifnocphffpjjpmpbg`. Private key in `.extension-key.pem`
(do not commit).

### Avoid recurring IDM block
The user has IDM Integration Module installed, which blocks unknown extension
IDs with `ERR_BLOCKED_BY_CLIENT`. Since we shipped a stable `key`, the new
extension ID is stable across rebuilds — don't drop the key field.

---

## 🟥 Anti-patterns I keep falling into (DON'T)

1. ❌ Writing temp `.tmp_foo.py` files and importing helpers manually instead
   of `browser-harness -c '...'`.
2. ❌ Taking a screenshot to "check if the FAB rendered" — the FAB is 52px
   in a 3842-px-wide screenshot. Use `js(...)`.
3. ❌ Assuming an action worked because no error was raised. Re-query state
   after every meaningful action.
4. ❌ Leaving `chatgpt` / `gpt-voyager` / purple hex literals in place
   "for later polish."
5. ❌ Re-implementing logic that claude-nexus already solved instead of just
   copying it.
6. ❌ Sleeping ad hoc (`time.sleep(5)`). If you must wait, wait for a DOM
   condition (`js('return !!document.querySelector(".gv-folder-container")')`
   in a tight poll).
