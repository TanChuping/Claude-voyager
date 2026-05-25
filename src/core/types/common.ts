/**
 * Common types used throughout the application
 * Following strict type safety principles
 */

export type Result<T, E = Error> = { success: true; data: T } | { success: false; error: E };

export interface IDisposable {
  dispose(): void;
}

export interface ILogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export type Maybe<T> = T | null | undefined;

/**
 * Brand type for type-safe IDs
 */
export type Brand<K, T> = K & { __brand: T };

export type ConversationId = Brand<string, 'ConversationId'>;
export type FolderId = Brand<string, 'FolderId'>;
export type TurnId = Brand<string, 'TurnId'>;

/**
 * Storage keys - centralized for type safety
 */
export const StorageKeys = {
  // Folder system
  FOLDER_DATA: 'cvFolderData',
  FOLDER_ENABLED: 'claudeFolderEnabled',
  FOLDER_HIDE_ARCHIVED_CONVERSATIONS: 'claudeFolderHideArchivedConversations',
  FOLDER_HIDE_ARCHIVED_NUDGE_SHOWN: 'claudeFolderHideArchivedNudgeShown',
  FOLDER_FLOATING_MODE_ENABLED: 'claudeFolderFloatingModeEnabled',
  FOLDER_FLOATING_NUDGE_SHOWN: 'claudeFolderFloatingNudgeShown',
  FOLDER_FLOATING_POS: 'claudeFolderFloatingPos',
  FOLDER_FLOATING_FAB_POS: 'claudeFolderFloatingFabPos',
  FOLDER_FLOATING_SIZE: 'claudeFolderFloatingSize',

  // Timeline
  TIMELINE_SCROLL_MODE: 'claudeTimelineScrollMode',
  TIMELINE_HIDE_CONTAINER: 'claudeTimelineHideContainer',
  TIMELINE_BAR_WIDTH: 'claudeTimelineBarWidth',
  TIMELINE_DRAGGABLE: 'claudeTimelineDraggable',
  TIMELINE_POSITION: 'claudeTimelinePosition',
  TIMELINE_PREVIEW_PINNED: 'claudeTimelinePreviewPinned',
  TIMELINE_MARKER_LEVEL: 'claudeTimelineMarkerLevel',
  TIMELINE_STARRED_MESSAGES: 'claudeTimelineStarredMessages',
  TIMELINE_HIERARCHY: 'claudeTimelineHierarchy',
  TIMELINE_SHORTCUTS: 'claudeTimelineShortcuts',

  // UI customization
  CHAT_WIDTH: 'claudeChatWidth',
  CHAT_WIDTH_ENABLED: 'cvChatWidthEnabled',
  CHAT_FONT_SIZE: 'cvChatFontSize',
  CHAT_FONT_SIZE_ENABLED: 'cvChatFontSizeEnabled',
  CODE_FONT_SIZE: 'cvCodeFontSize',
  CODE_FONT_SIZE_ENABLED: 'cvCodeFontSizeEnabled',
  // Font family (chat + composer).  Presets: 'default' | 'gemini' | 'gpt'
  // | 'custom'.  Custom font binary lives in chrome.storage.local under
  // CHAT_CUSTOM_FONT_DATA (woff2/woff/ttf/otf base64), since storage.sync
  // has an 8 KB per-item limit.
  CHAT_FONT_FAMILY: 'cvChatFontFamily',
  CHAT_FONT_FAMILY_ENABLED: 'cvChatFontFamilyEnabled',
  CHAT_CUSTOM_FONT_NAME: 'cvChatCustomFontName',
  CHAT_CUSTOM_FONT_FORMAT: 'cvChatCustomFontFormat',
  CHAT_CUSTOM_FONT_DATA: 'cvChatCustomFontData',
  EDIT_INPUT_WIDTH: 'claudeEditInputWidth',
  EDIT_INPUT_WIDTH_ENABLED: 'cvEditInputWidthEnabled',
  SIDEBAR_WIDTH: 'claudeSidebarWidth',
  SIDEBAR_WIDTH_ENABLED: 'cvSidebarWidthEnabled',

  // Prompt Manager
  PROMPT_ITEMS: 'cvPromptItems',
  PROMPT_PANEL_LOCKED: 'cvPromptPanelLocked',
  PROMPT_PANEL_POSITION: 'cvPromptPanelPosition',
  PROMPT_TRIGGER_POSITION: 'cvPromptTriggerPosition',
  PROMPT_CUSTOM_WEBSITES: 'cvPromptCustomWebsites',
  PROMPT_THEME: 'cvPromptTheme',
  PROMPT_INSERT_ON_CLICK: 'cvPromptInsertOnClick',
  PROMPT_VIEW_MODE: 'cvPromptViewMode',

  // Global settings
  LANGUAGE: 'language',
  FORMULA_COPY_FORMAT: 'cvFormulaCopyFormat',
  HIDE_PROMPT_MANAGER: 'cvHidePromptManager',
  MERMAID_ENABLED: 'cvMermaidEnabled',
  QUOTE_REPLY_ENABLED: 'cvQuoteReplyEnabled',

  // Input behavior
  CTRL_ENTER_SEND: 'cvCtrlEnterSend',
  SAFARI_ENTER_FIX: 'cvSafariEnterFix',
  INPUT_COLLAPSE_ENABLED: 'cvInputCollapseEnabled',
  INPUT_COLLAPSE_WHEN_NOT_EMPTY: 'cvInputCollapseWhenNotEmpty',
  INPUT_VIM_MODE: 'cvInputVimMode',
  DRAFT_AUTO_SAVE: 'cvDraftAutoSave',
  PREVENT_AUTO_SCROLL_ENABLED: 'cvPreventAutoScrollEnabled',

  // Sidebar behavior
  GV_SIDEBAR_AUTO_HIDE: 'cvSidebarAutoHide',
  GV_SIDEBAR_FULL_HIDE: 'cvSidebarFullHide',

  // Folder spacing
  GV_FOLDER_SPACING: 'cvFolderSpacing',
  GV_FOLDER_TREE_INDENT: 'cvFolderTreeIndent',
  GV_FOLDER_FILTER_USER_ONLY: 'cvFolderFilterUserOnly',
  GV_ACCOUNT_ISOLATION_ENABLED: 'cvAccountIsolationEnabled',

  // Fork nodes
  FORK_NODES: 'cvForkNodes',
  FORK_ENABLED: 'cvForkEnabled',

  // Export
  EXPORT_IMAGE_WIDTH: 'cvExportImageWidth',
  /**
   * Single-conversation export format chosen in the popup. Drives the
   * top-bar download button. See `SingleConvExportFormat` in
   * `src/features/singleConvExport/index.ts` for the union.
   */
  SINGLE_CONV_EXPORT_FORMAT: 'cvSingleConvExportFormat',

  // Message timestamps
  GV_SHOW_MESSAGE_TIMESTAMPS: 'cvShowMessageTimestamps',
  GV_MESSAGE_TIMESTAMPS: 'cvMessageTimestamps',

  // Popup section order
  GV_POPUP_SECTION_ORDER: 'cvPopupSectionOrder',

  // Folder as Project
  FOLDER_PROJECT_ENABLED: 'cvFolderProjectEnabled',
  FOLDER_PROJECT_PENDING_FOLDER_ID: 'cvFolderProjectPendingFolderId',
} as const;

export type StorageKey = (typeof StorageKeys)[keyof typeof StorageKeys];
