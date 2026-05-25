/**
 * KaTeX Configuration Override Script
 * This script runs in the page context (not content script context)
 * to suppress KaTeX strict mode warnings for Unicode text in math mode
 */

(function () {
  'use strict';

  // Monkey patch console.warn to suppress specific KaTeX warnings
  const originalWarn = console.warn;
  console.warn = function (...args) {
    const message = args[0];

    // Suppress KaTeX Unicode warnings and noisy 3rd-party warnings that
    // we cannot fix (ProseMirror's white-space hint is emitted by Claude.ai's
    // own editor bundle and is harmless for us).
    if (
      typeof message === 'string' &&
      (message.includes('unicodeTextInMathMode') ||
        message.includes('LaTeX-incompatible input and strict mode') ||
        message.includes("KaTeX doesn't work in quirks mode") ||
        message.includes('No ID or name found in config') ||
        message.includes('ProseMirror expects the CSS white-space property'))
    ) {
      // Silently ignore these warnings
      return;
    }

    // Pass through all other warnings
    return originalWarn.apply(console, args);
  };

  console.log('[Claude-Voyager] KaTeX configuration applied - Unicode warnings suppressed');
})();
