// ─── wmux UI internationalization — pure core (issue #56) ────────────────────
// Types, dictionaries and pure helpers with NO store dependency. The settings
// slice imports from here (for the default-language detection at store-creation
// time); keeping this module store-free avoids a circular import between the
// store and the `useT` hook (which lives in ./index and *does* read the store).
//
// Coverage is intentionally pragmatic ("main UI"): Settings chrome, the General
// panel, command palette, titlebar, and the workspace context menu. Any key not
// present in the active language falls back to English, then to the literal key,
// so partial translations never render blank.

export type Language = 'en' | 'fr' | 'zh';

export const LANGUAGES: ReadonlyArray<{ code: Language; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'zh', label: '中文' },
];

export const SUPPORTED_LANGUAGES: ReadonlyArray<Language> = LANGUAGES.map((l) => l.code);

type Dict = Record<string, string>;

const en: Dict = {
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
  // Titlebar — update badge (issue #88)
  'titlebar.updateAvailable': 'Update available',
  'titlebar.updateDownload': 'Click to download from GitHub',
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
};

const fr: Dict = {
  'settings.title': 'Paramètres',
  'settings.tab.general': 'Général',
  'settings.tab.sidebar': 'Barre latérale',
  'settings.tab.workspace': 'Espace de travail',
  'settings.tab.terminal': 'Terminal',
  'settings.tab.notifications': 'Notifications',
  'settings.tab.browser': 'Navigateur',
  'settings.tab.profiles': 'Profils',
  'settings.tab.shortcuts': 'Raccourcis',
  'settings.general.languageSection': 'Langue',
  'settings.general.language': "Langue de l'interface",
  'settings.general.languageHint':
    "Les changements s'appliquent immédiatement. Le texte non traduit s'affiche en anglais.",
  'settings.general.appearanceSection': 'Apparence',
  'settings.general.uiTheme': "Thème de l'application",
  'settings.general.uiTheme.system': 'Suivre le système',
  'settings.general.uiTheme.dark': 'Sombre',
  'settings.general.uiTheme.light': 'Clair',
  'settings.general.appearanceHint':
    "Contrôle la barre latérale, la barre d'onglets et le cadre de la fenêtre. Les couleurs du terminal se règlent séparément.",
  'palette.placeholder': 'Tapez une commande ou recherchez...',
  'palette.empty': 'Aucun résultat',
  'palette.category.actions': 'Actions',
  'palette.category.commands': 'Commandes',
  'palette.category.workspaces': 'Espaces de travail',
  'palette.category.themes': 'Thèmes',
  'palette.openMarkdown': 'Ouvrir un fichier Markdown…',
  'palette.current': 'actuel',
  'titlebar.help': 'Aide / Tutoriel',
  'titlebar.devtools': 'Afficher/Masquer les outils de développement',
  'titlebar.settings': 'Paramètres (Ctrl+,)',
  'titlebar.updateAvailable': 'Mise à jour disponible',
  'titlebar.updateDownload': 'Clic pour télécharger sur GitHub',
  'settings.tab.help': 'Aide',
  'settings.help.about': 'À propos de wmux',
  'settings.help.version': 'Version',
  'settings.help.reportIssue': 'Signaler un problème',
  'settings.help.website': 'Site web',
  'settings.help.hint': 'Un bug ou une suggestion ? Ouvrez un ticket sur GitHub.',
  'ctx.pin': "Épingler l'espace",
  'ctx.unpin': "Désépingler l'espace",
  'ctx.rename': "Renommer l'espace…",
  'ctx.color': "Couleur de l'espace",
  'ctx.clearColor': 'Effacer la couleur',
  'ctx.moveUp': 'Monter',
  'ctx.moveDown': 'Descendre',
  'ctx.moveTop': 'Déplacer en haut',
  'ctx.close': "Fermer l'espace",
  'ctx.closeOthers': 'Fermer les autres espaces',
  'ctx.markRead': 'Marquer comme lu',
  'ctx.markUnread': 'Marquer comme non lu',
  'ctx.status': "Indicateur d'état",
  'ctx.statusAuto': 'Auto (détecté)',
  'ctx.statusRunning': 'Épingler « En cours »',
  'ctx.statusIdle': 'Épingler « Inactif »',
};

const zh: Dict = {
  'settings.title': '设置',
  'settings.tab.general': '常规',
  'settings.tab.sidebar': '侧边栏',
  'settings.tab.workspace': '工作区',
  'settings.tab.terminal': '终端',
  'settings.tab.notifications': '通知',
  'settings.tab.browser': '浏览器',
  'settings.tab.profiles': '配置文件',
  'settings.tab.shortcuts': '快捷键',
  'settings.general.languageSection': '语言',
  'settings.general.language': '界面语言',
  'settings.general.languageHint': '更改立即生效。未翻译的文本将回退为英文。',
  'settings.general.appearanceSection': '外观',
  'settings.general.uiTheme': '应用主题',
  'settings.general.uiTheme.system': '跟随系统',
  'settings.general.uiTheme.dark': '深色',
  'settings.general.uiTheme.light': '浅色',
  'settings.general.appearanceHint': '控制侧边栏、标签栏和窗口外框。终端颜色需单独设置。',
  'palette.placeholder': '输入命令或搜索...',
  'palette.empty': '未找到结果',
  'palette.category.actions': '操作',
  'palette.category.commands': '命令',
  'palette.category.workspaces': '工作区',
  'palette.category.themes': '主题',
  'palette.openMarkdown': '打开 Markdown 文件…',
  'palette.current': '当前',
  'titlebar.help': '帮助 / 教程',
  'titlebar.devtools': '切换开发者工具',
  'titlebar.settings': '设置 (Ctrl+,)',
  'titlebar.updateAvailable': '有可用更新',
  'titlebar.updateDownload': '点击前往 GitHub 下载',
  'settings.tab.help': '帮助',
  'settings.help.about': '关于 wmux',
  'settings.help.version': '版本',
  'settings.help.reportIssue': '报告问题',
  'settings.help.website': '网站',
  'settings.help.hint': '发现错误或有建议？请在 GitHub 上提交问题。',
  'ctx.pin': '固定工作区',
  'ctx.unpin': '取消固定工作区',
  'ctx.rename': '重命名工作区…',
  'ctx.color': '工作区颜色',
  'ctx.clearColor': '清除颜色',
  'ctx.moveUp': '上移',
  'ctx.moveDown': '下移',
  'ctx.moveTop': '移到顶部',
  'ctx.close': '关闭工作区',
  'ctx.closeOthers': '关闭其他工作区',
  'ctx.markRead': '标记为已读',
  'ctx.markUnread': '标记为未读',
  'ctx.status': '状态指示',
  'ctx.statusAuto': '自动（检测）',
  'ctx.statusRunning': '固定为运行中',
  'ctx.statusIdle': '固定为空闲',
};

const DICTS: Record<Language, Dict> = { en, fr, zh };

/** Translate a key for an explicit language (English → key fallback chain). */
export function translate(lang: Language, key: string, fallback?: string): string {
  return DICTS[lang]?.[key] ?? DICTS.en[key] ?? fallback ?? key;
}

/**
 * Best-effort default from the OS/browser locale so first-launch users (e.g. the
 * Chinese reporter of issue #56) see their language without touching Settings.
 * Falls back to English for anything unsupported.
 */
export function detectDefaultLanguage(): Language {
  try {
    const nav = (globalThis as any).navigator?.language ?? 'en';
    const base = String(nav).toLowerCase().split('-')[0];
    if (SUPPORTED_LANGUAGES.includes(base as Language)) return base as Language;
  } catch {
    /* navigator unavailable (tests) */
  }
  return 'en';
}
