// ─── English — the source of truth for the UI vocabulary (issue #56) ─────────
// Every other locale is typed against this file: `Translation` accepts any
// subset of these keys and rejects anything else, so a typo or a key left
// behind after an English rename is a compile error, not a silent blank.
//
// Adding a string: add it here first, then translate it in the sibling files.
// Untranslated keys fall back to English at runtime, so shipping a key before
// its translations is safe.

export const en = {
  // Settings — window chrome
  'settings.title': 'Settings',
  'settings.tab.general': 'General',
  'settings.tab.sidebar': 'Sidebar',
  'settings.tab.workspace': 'Workspace',
  'settings.tab.terminal': 'Terminal',
  'settings.tab.notifications': 'Notifications',
  'settings.tab.browser': 'Browser',
  'settings.tab.profiles': 'Profiles',
  'settings.tab.shortcuts': 'Shortcuts',
  // Settings — General panel
  'settings.general.languageSection': 'Language',
  'settings.general.language': 'Interface language',
  'settings.general.languageHint':
    'Changes apply immediately. Untranslated text falls back to English.',
  // Settings — General panel — Appearance (issue #67)
  'settings.general.appearanceSection': 'Appearance',
  'settings.general.uiTheme': 'App theme',
  'settings.general.uiTheme.system': 'Follow system',
  'settings.general.uiTheme.dark': 'Dark',
  'settings.general.uiTheme.light': 'Light',
  'settings.general.appearanceHint':
    'Controls the sidebar, tab bar, and window chrome. Terminal colors are set separately.',
  // Settings — General panel — Explorer context menu
  'settings.general.shellSection': 'Windows Explorer',
  'settings.general.contextMenu': 'Add "Open in wmux" to the folder context menu',
  'settings.general.contextMenuLabel': 'Open in wmux',
  'settings.general.contextMenuHint':
    'Right-click a folder — or its empty space — to open it as a workspace, instead of pasting the path. On Windows 11 it appears under "Show more options" (Shift+F10); the modern top-level menu requires a signed MSIX package. Writes only to HKCU, so no admin rights are needed.',
  'settings.general.contextMenuFailed': 'Could not update the context menu entry.',
  // Settings — General panel — Custom background (issue #89)
  'settings.general.customBgSection': 'Custom background',
  'settings.general.customBgEnable': 'Enable custom background',
  'settings.general.customBgCss': 'Background (CSS)',
  'settings.general.customBgPreset': 'Preset',
  'settings.general.customBgPreset.none': 'Choose a preset…',
  'settings.general.customBgOpacity': 'Terminal opacity',
  'settings.general.customBgHint':
    'Any CSS background: a color, gradients, or url(…) images. Drawn behind the terminals, independent of the color scheme. Terminal opacity controls how much shows through.',
  // Command palette
  'palette.placeholder': 'Type a command or search...',
  'palette.empty': 'No results found',
  'palette.category.actions': 'Actions',
  'palette.category.commands': 'Commands',
  'palette.category.workspaces': 'Workspaces',
  'palette.category.themes': 'Themes',
  'palette.openMarkdown': 'Open Markdown File…',
  'palette.current': 'current',
  // Titlebar
  'titlebar.help': 'Help / Tutorial',
  'titlebar.devtools': 'Toggle Developer Tools',
  'titlebar.settings': 'Settings (Ctrl+,)',
  // Titlebar — update badge (issue #88; in-app install, issue #125)
  'titlebar.updateAvailable': 'Update available',
  'titlebar.updateDownload': 'Click to download from GitHub',
  'titlebar.updateInstall': 'Click to download and install',
  'titlebar.updateChecking': 'Checking…',
  'titlebar.updateDownloading': 'Downloading update',
  'titlebar.updateReady': 'Update ready',
  'titlebar.updateRestart': 'Restart',
  'titlebar.updateRestartHint': 'Click to restart into the new version',
  'titlebar.updateFailed': 'Update failed',
  'titlebar.updateRetry': 'Click to try again',
  // Settings — Help / About panel
  'settings.tab.help': 'Help',
  'settings.help.about': 'About wmux',
  'settings.help.version': 'Version',
  'settings.help.reportIssue': 'Report an Issue',
  'settings.help.website': 'Website',
  'settings.help.hint': 'Found a bug or have a request? Open an issue on GitHub.',
  // Workspace context menu
  'ctx.pin': 'Pin Workspace',
  'ctx.unpin': 'Unpin Workspace',
  'ctx.rename': 'Rename Workspace…',
  'ctx.color': 'Workspace Color',
  'ctx.clearColor': 'Clear Color',
  'ctx.moveUp': 'Move Up',
  'ctx.moveDown': 'Move Down',
  'ctx.moveTop': 'Move to Top',
  'ctx.close': 'Close Workspace',
  'ctx.closeOthers': 'Close Other Workspaces',
  'ctx.markRead': 'Mark as Read',
  'ctx.markUnread': 'Mark as Unread',
  'ctx.status': 'Status Indicator',
  'ctx.statusAuto': 'Auto (detected)',
  'ctx.statusRunning': 'Pin as Running',
  'ctx.statusIdle': 'Pin as Idle',
  // Markdown pane toolbar (issue #116)
  'markdown.preview': 'Preview',
  'markdown.source': 'Source',
  'markdown.copy': 'Copy',
  'markdown.copied': 'Copied',
  'markdown.copyDocument': 'Copy the raw markdown',
  'markdown.copyBlock': 'Copy this code block',
  'markdown.copyPath': 'Copy file path',
  'markdown.copyRelativePath': 'Copy relative path',
  'markdown.copyPathHint': 'Click to copy the full path',
  'markdown.copiedPath': 'Path copied',
  'markdown.reload': 'Reload from disk',
  'markdown.reveal': 'Reveal in File Explorer',
  'markdown.openInApp': 'Open in default app',
  'markdown.moreActions': 'More actions',
  'markdown.noFile': 'Not backed by a file',
  'markdown.empty': 'No content. Use wmux markdown set to add content, or drop a file here.',
  'markdown.error.copy': 'Could not write to the clipboard',
  'markdown.error.read': 'Could not read the file',
  'markdown.error.action': 'The action failed',
  'markdown.edit': 'Edit',
  'markdown.editHint': 'Edit the source in place (Ctrl+S to save)',
  'markdown.save': 'Save',
  'markdown.saveHint': 'Write the buffer back to the file (Ctrl+S)',
  'markdown.revert': 'Discard changes',
  'markdown.conflict': 'This file changed on disk since it was loaded.',
  'markdown.conflict.reload': 'Reload and lose my edits',
  'markdown.conflict.overwrite': 'Overwrite',
  'markdown.conflict.saveAs': 'Save as copy',
  'markdown.error.save': 'Could not save the file',
  'markdown.error.conflict': 'The file changed on disk — nothing was written',
  'markdown.closeUnsaved': 'Close “{name}” without saving?',
  'markdown.closeUnsavedHint': 'This note has edits that were never written to disk.',
  'markdown.keepEditing': 'Keep editing',
  'markdown.discardAndClose': 'Discard and close',
} as const;

/** Every key the UI may ask for — derived from English, the source of truth. */
export type TranslationKey = keyof typeof en;

/**
 * A locale's dictionary. Partial on purpose: a missing key falls back to
 * English at runtime, so partial translations are legal. An *unknown* key is
 * not — that catches typos and keys stranded by an English rename.
 */
export type Translation = Partial<Record<TranslationKey, string>>;
