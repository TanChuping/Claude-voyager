/**
 * Bootstrap for the incognito-chat hand-off feature.
 *
 * Mounts the top-bar button only; the actual flow runs on click and
 * lives in `orchestrator.ts`.  We also call `resumePendingHandoff` on
 * every bootstrap — if the previous page-in-this-tab clicked Regret
 * and we just landed on the fresh persistent chat, this picks up the
 * stashed payload and pastes it into the composer.
 */
import { resumePendingHandoff } from './orchestrator';
import { startTempChatRegretButton, stopTempChatRegretButton } from './topBarButton';

let started = false;

export function startTempChatExit(): void {
  if (started) return;
  started = true;
  startTempChatRegretButton();
  void resumePendingHandoff();
}

export function stopTempChatExit(): void {
  if (!started) return;
  started = false;
  stopTempChatRegretButton();
}
