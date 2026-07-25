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
  'settings.general.shellSection': 'Explorateur Windows',
  'settings.general.contextMenu': 'Ajouter « Ouvrir dans wmux » au menu contextuel des dossiers',
  'settings.general.contextMenuLabel': 'Ouvrir dans wmux',
  'settings.general.contextMenuHint':
    "Clic droit sur un dossier — ou dans son espace vide — pour l'ouvrir comme workspace, au lieu de coller le chemin. Sous Windows 11, l'entrée apparaît dans « Afficher d'autres options » (Maj+F10) ; le menu moderne exige un paquet MSIX signé. N'écrit que dans HKCU, aucun droit administrateur requis.",
  'settings.general.contextMenuFailed': "Impossible de mettre à jour l'entrée du menu contextuel.",
  'settings.general.customBgSection': 'Arrière-plan personnalisé',
  'settings.general.customBgEnable': "Activer l'arrière-plan personnalisé",
  'settings.general.customBgCss': 'Arrière-plan (CSS)',
  'settings.general.customBgPreset': 'Préréglage',
  'settings.general.customBgPreset.none': 'Choisir un préréglage…',
  'settings.general.customBgOpacity': 'Opacité du terminal',
  'settings.general.customBgHint':
    "N'importe quel arrière-plan CSS : couleur, dégradés ou images url(…). Dessiné derrière les terminaux, indépendamment du jeu de couleurs. L'opacité du terminal contrôle sa visibilité.",
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
  // Panneau markdown (issue #116)
  'markdown.preview': 'Aperçu',
  'markdown.source': 'Source',
  'markdown.copy': 'Copier',
  'markdown.copied': 'Copié',
  'markdown.copyDocument': 'Copier le markdown brut',
  'markdown.copyBlock': 'Copier ce bloc de code',
  'markdown.copyPath': 'Copier le chemin du fichier',
  'markdown.copyRelativePath': 'Copier le chemin relatif',
  'markdown.copyPathHint': 'Cliquer pour copier le chemin complet',
  'markdown.copiedPath': 'Chemin copié',
  'markdown.reload': 'Recharger depuis le disque',
  'markdown.reveal': "Afficher dans l'Explorateur",
  'markdown.openInApp': "Ouvrir dans l'application par défaut",
  'markdown.moreActions': 'Autres actions',
  'markdown.noFile': 'Aucun fichier associé',
  'markdown.empty': 'Aucun contenu. Utilisez wmux markdown set, ou déposez un fichier ici.',
  'markdown.error.copy': "Impossible d'écrire dans le presse-papiers",
  'markdown.error.read': 'Impossible de lire le fichier',
  'markdown.error.action': "L'action a échoué",
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
  'settings.general.shellSection': 'Windows 资源管理器',
  'settings.general.contextMenu': '在文件夹右键菜单中添加"在 wmux 中打开"',
  'settings.general.contextMenuLabel': '在 wmux 中打开',
  'settings.general.contextMenuHint':
    '右键点击文件夹或其空白处，即可将其作为工作区打开，无需粘贴路径。在 Windows 11 上该项位于"显示更多选项"（Shift+F10）中；新版顶层菜单需要已签名的 MSIX 包。仅写入 HKCU，无需管理员权限。',
  'settings.general.contextMenuFailed': '无法更新右键菜单项。',
  'settings.general.customBgSection': '自定义背景',
  'settings.general.customBgEnable': '启用自定义背景',
  'settings.general.customBgCss': '背景（CSS）',
  'settings.general.customBgPreset': '预设',
  'settings.general.customBgPreset.none': '选择预设…',
  'settings.general.customBgOpacity': '终端不透明度',
  'settings.general.customBgHint':
    '任意 CSS 背景：纯色、渐变或 url(…) 图片。绘制在终端后面，与配色方案无关。终端不透明度控制其可见程度。',
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
  // Markdown 面板 (issue #116)
  'markdown.preview': '预览',
  'markdown.source': '源码',
  'markdown.copy': '复制',
  'markdown.copied': '已复制',
  'markdown.copyDocument': '复制原始 Markdown',
  'markdown.copyBlock': '复制此代码块',
  'markdown.copyPath': '复制文件路径',
  'markdown.copyRelativePath': '复制相对路径',
  'markdown.copyPathHint': '点击复制完整路径',
  'markdown.copiedPath': '路径已复制',
  'markdown.reload': '从磁盘重新加载',
  'markdown.reveal': '在资源管理器中显示',
  'markdown.openInApp': '用默认应用打开',
  'markdown.moreActions': '更多操作',
  'markdown.noFile': '未关联文件',
  'markdown.empty': '暂无内容。请使用 wmux markdown set，或将文件拖放到此处。',
  'markdown.error.copy': '无法写入剪贴板',
  'markdown.error.read': '无法读取文件',
  'markdown.error.action': '操作失败',
};

const DICTS: Record<Language, Dict> = { en, fr, zh };

/** Translate a key for an explicit language (English → key fallback chain). */
export function translate(lang: Language, key: string, fallback?: string): string {
  return DICTS[lang]?.[key] ?? DICTS.en[key] ?? fallback ?? key;
}

/** "fr-FR" / "fr_FR" → "fr"; returns undefined for unsupported languages. */
function toSupported(tag: unknown): Language | undefined {
  const base = String(tag ?? '').toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LANGUAGES.includes(base as Language) ? (base as Language) : undefined;
}

/**
 * Best-effort default from the OS locale so first-launch users (e.g. the
 * Chinese reporter of issue #56) see their language without touching Settings.
 *
 * The OS display-language list (GetUserPreferredUILanguages via the preload
 * bridge) is consulted FIRST: navigator.language follows Chromium's locale
 * resolution, which can pick up regional-format/Accept-Language settings and
 * disagree with the language Windows actually displays — issue #114 was an
 * English-display machine getting French tooltips this way. The first entry
 * in a supported language wins; anything unsupported falls back to English.
 */
export function detectDefaultLanguage(): Language {
  try {
    const preferred: unknown = (globalThis as any).window?.wmux?.settings?.getPreferredLanguagesSync?.();
    if (Array.isArray(preferred) && preferred.length) {
      // The OS list is authoritative when present — match the display language
      // (entry 0), not "any supported language anywhere in the list", so a
      // machine displaying English with French further down stays English.
      return toSupported(preferred[0]) ?? 'en';
    }
  } catch {
    /* preload bridge unavailable (tests) */
  }
  try {
    const lang = toSupported((globalThis as any).navigator?.language);
    if (lang) return lang;
  } catch {
    /* navigator unavailable (tests) */
  }
  return 'en';
}
