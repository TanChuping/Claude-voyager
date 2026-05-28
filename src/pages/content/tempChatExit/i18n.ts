/**
 * Local i18n helper for the temp-chat-exit feature.
 *
 * `getTranslationSync` from the shared layer gives us localized strings,
 * but it doesn't do placeholder substitution.  We need things like
 * "Loaded {count} messages…" rendered with the actual number, so this
 * thin wrapper adds a `{name}` → value substitution pass and a defensive
 * try/catch for the cold-load race where init may not have completed.
 */
import { getTranslationSync } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  let raw: string;
  try {
    raw = getTranslationSync(key);
  } catch {
    raw = String(key);
  }
  if (!vars) return raw;
  let out = raw;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}
