/**
 * Page-world fetch/XHR hook for Claude.ai.
 *
 * Runs in MAIN world so it can wrap Claude's own `window.fetch` and
 * `XMLHttpRequest.prototype.open`. Whenever Claude issues
 *   GET /api/organizations/<org_uuid>/chat_conversations/<conv_uuid>?...
 * we clone the response body, parse it as JSON, and dispatch the payload via
 * `window.postMessage` so the content-script-world code can pick it up.
 *
 * Why piggyback?  The endpoint requires the session cookie that's bound to
 * claude.ai.  Outside the page we'd have to set up our own request with
 * matching credentials.  Since Claude itself fires this fetch every time a
 * user opens a conversation, hooking lets us silently capture the payload
 * with zero extra network cost.
 *
 * Cold-start path:  the first conversation fetch on a fresh page load can
 * fire before our content-script (isolated-world) listener installs.  To
 * handle that we ALSO stash the latest capture in `sessionStorage` under a
 * magic key prefix; the content-script re-ingests on init then clears.
 */

// Match the bare conversation endpoint.  We intentionally exclude:
//   - .../chat_conversations/<id>/messages      (per-message subresource)
//   - .../chat_conversations/<id>/title         (rename)
//   - .../chat_conversations/<id>/completion    (streaming)
// because they don't carry the full mapping we want.
const CONV_RE =
  /\/api\/organizations\/([a-f0-9-]+)\/chat_conversations\/([a-f0-9-]+)(?:\?|$|#)/i;

const ORG_STORAGE_KEY = 'cv-last-org-uuid';

function extractIds(
  url: string | URL | undefined | null,
): { orgId: string; convId: string } | null {
  if (!url) return null;
  const s = typeof url === 'string' ? url : url.toString();
  const m = CONV_RE.exec(s);
  if (!m) return null;
  // Reject paths that have a trailing sub-resource segment (messages, title, completion).
  const after = s.slice((m.index ?? 0) + m[0].length);
  if (after.startsWith('/')) return null;
  return { orgId: m[1], convId: m[2] };
}

function extractConvId(url: string | URL | undefined | null): string | null {
  return extractIds(url)?.convId ?? null;
}

function rememberOrg(orgId: string): void {
  try {
    localStorage.setItem(ORG_STORAGE_KEY, orgId);
  } catch {
    /* ignore quota */
  }
}

const SESSION_KEY_PREFIX = 'cv-cap-'; // claude-voyager capture

function dispatchCaptured(convId: string, data: unknown, source: 'fetch' | 'xhr'): void {
  const payload = { convId, data, source, capturedAt: Date.now() };
  try {
    window.postMessage({ __cvType: 'cv-conv-captured', payload }, window.location.origin);
  } catch {
    /* swallow — never break Claude */
  }
  try {
    sessionStorage.setItem(SESSION_KEY_PREFIX + convId, JSON.stringify(payload));
  } catch {
    /* quota exceeded / private mode — postMessage is still our primary */
  }
}

(function installFetchHook() {
  if ((window as unknown as { __cvFetchHooked?: boolean }).__cvFetchHooked) return;
  (window as unknown as { __cvFetchHooked?: boolean }).__cvFetchHooked = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function cvHookedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await originalFetch(input as RequestInfo, init);
    try {
      const url = typeof input === 'string' || input instanceof URL ? input : input.url;
      const ids = extractIds(url);
      if (ids && response.ok) {
        rememberOrg(ids.orgId);
        response
          .clone()
          .json()
          .then((data) => dispatchCaptured(ids.convId, data, 'fetch'))
          .catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    return response;
  };
})();

(function installXhrHook() {
  if ((window as unknown as { __cvXhrHooked?: boolean }).__cvXhrHooked) return;
  (window as unknown as { __cvXhrHooked?: boolean }).__cvXhrHooked = true;

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function cvHookedOpen(
    this: XMLHttpRequest & { __cvConvId?: string | null },
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      const ids = extractIds(url);
      this.__cvConvId = ids?.convId ?? null;
      if (ids) rememberOrg(ids.orgId);
      if (this.__cvConvId) {
        this.addEventListener('load', () => {
          try {
            if (this.status >= 200 && this.status < 300) {
              const text =
                this.responseType === '' || this.responseType === 'text'
                  ? this.responseText
                  : null;
              if (text) {
                const parsed = JSON.parse(text);
                dispatchCaptured(this.__cvConvId as string, parsed, 'xhr');
              }
            }
          } catch {
            /* ignore */
          }
        });
      }
    } catch {
      /* ignore */
    }
    return originalOpen.call(
      this,
      method,
      url as string,
      ...(rest as [boolean, string?, string?]),
    );
  } as typeof XMLHttpRequest.prototype.open;
})();
