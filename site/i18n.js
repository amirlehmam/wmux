/**
 * wmux i18n — 22 languages, browser detection, RTL support
 */
const LANGS = {
  en: "English",
  fr: "Français",
  es: "Español",
  de: "Deutsch",
  pt: "Português",
  it: "Italiano",
  nl: "Nederlands",
  pl: "Polski",
  tr: "Türkçe",
  ru: "Русский",
  uk: "Українська",
  ar: "العربية",
  zh: "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  ko: "한국어",
  hi: "हिन्दी",
  vi: "Tiếng Việt",
  th: "ภาษาไทย",
  id: "Bahasa Indonesia",
  sv: "Svenska",
  cs: "Čeština",
};

const RTL_LANGS = ["ar"];

const T = {
  // ═══════════════════════════ ENGLISH ═══════════════════════════
  en: {
    "nav.docs": "Docs",
    "nav.changelog": "Changelog",
    "nav.community": "Community",
    "nav.github": "GitHub",
    "header.download": "Download for Windows",
    "hero.tagline": "The terminal built for",
    "hero.word1": "Claude Code",
    "hero.word2": "AI agents",
    "hero.word3": "multitasking",
    "hero.word4": "Windows",
    "hero.desc":
      "Windows application built on Electron. Vertical tabs, notifications when agents need attention, split panes, built-in browser and a pipe API for automation.",
    "hero.download": "Download for Windows",
    "hero.github": "View on GitHub",
    "features.title": "Features",
    "f1.name": "Passive Claude Code integration",
    "f1.desc":
      'wmux observes Claude Code without modifying its behavior. A CDP proxy on <code>localhost:9222</code> lets the built-in browser show every action in real time. Auto-configured hooks report agent and tool activity to the sidebar. Zero configuration.',
    "f2.name": "Built-in browser",
    "f2.desc":
      'open a browser alongside your terminal with a scriptable API. When Claude Code browses via <code>chrome-devtools-mcp</code>, every page, click and form fill is visible in the browser panel.',
    "f3.name": "Notification rings",
    "f3.desc":
      "panels glow blue when agents need attention. Windows toast notification, taskbar flash, and built-in notification center.",
    "f4.name": "Vertical tabs",
    "f4.desc":
      "the sidebar displays git branch, working directory, ports, agent count, PR status and notification text. Double-click to rename.",
    "f5.name": "Split panes",
    "f5.desc":
      "horizontal and vertical splits in each tab. Ctrl+D to split right, Ctrl+Shift+D to split down.",
    "f6.name": "Activity indicators",
    "f6.desc":
      "pulsing orange = working, green = done, red = interrupted. Visible at a glance in the sidebar.",
    "f7.name": "Saved sessions",
    "f7.desc":
      "save your splits, directories and browser URL. Automatic restore on startup.",
    "f8.name": "Scriptable",
    "f8.desc":
      'CLI and named pipe API (<code>\\\\.\\pipe\\wmux</code>) for automation and scripting. JSON-RPC v2 protocol compatible with cmux.',
    "f9.name": "Windows native",
    "f9.desc":
      "ConPTY for terminal emulation, Windows toast notifications, taskbar flash, native title bar overlay.",
    "f10.name": "GPU acceleration",
    "f10.desc": "powered by xterm.js with WebGL rendering for smooth display.",
    "f11.name": "Theme compatible",
    "f11.desc":
      "import your themes from Windows Terminal or Ghostty. 450+ bundled Ghostty themes.",
    "f12.name": "Keyboard shortcuts",
    "f12.desc":
      "full shortcuts for workspaces, splits, browser and more.",
    "faq.title": "Frequently asked questions",
    "faq1.q": "What is the relationship between wmux and cmux?",
    "faq1.a":
      'wmux is a Windows fork of <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>. cmux is a native macOS app (Swift + AppKit + Ghostty). wmux reproduces the same experience on Windows using Electron + xterm.js + ConPTY. The CLI/pipe protocol is compatible between the two.',
    "faq2.q": "What platforms are supported?",
    "faq2.a":
      'Windows 10 and 11 only (x64). For macOS, use <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>. For Linux, the project can theoretically be built from source but is not officially supported.',
    "faq3.q": "Which agents are compatible?",
    "faq3.a":
      "wmux is optimized for Claude Code with automatic passive integration (hooks, CDP proxy, CLAUDE.md). Any command-line agent or program can be used in wmux terminals — Codex, Gemini CLI, Aider, OpenCode, or any script.",
    "faq4.q": "How do notifications work?",
    "faq4.a":
      'Shell integration scripts detect when a command finishes or is interrupted. The pane gets a blue ring, the sidebar badge increments, and a Windows toast notification appears. Supports OSC 9/99/777, the <code>wmux notify</code> CLI, and idle detection.',
    "faq5.q": "How is it different from Windows Terminal?",
    "faq5.a":
      "Windows Terminal is an excellent terminal emulator, but it has no notification system, no agent activity visibility, no built-in browser, and no live metadata (git branch, ports, PR) in tabs. wmux is specifically designed to supervise AI agents.",
    "faq6.q": "Is it free?",
    "faq6.a":
      'Yes. wmux is open-source under the AGPL-3.0 license. Free download on <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Download for Windows",
    "cta.github": "View on GitHub",
    "footer.product": "Product",
    "footer.changelog": "Changelog",
    "footer.community": "Community",
    "footer.releases": "Releases",
    "footer.resources": "Resources",
    "footer.docs": "Documentation",
    "footer.install": "Installation",
    "footer.shortcuts": "Shortcuts",
    "footer.legal": "Legal",
    "footer.license": "AGPL-3.0 License",
    "footer.social": "Social",
    "footer.copyright": "© 2026 wmux",
    "footer.fork": "Windows fork of",
    "plugin.badge": "Claude Code Plugin",
    "plugin.desc": "Launch multiple Claude Code agents in parallel from a single command. The plugin analyzes your codebase, splits the task into independent subtasks, and distributes them in waves with dependency management, isolated file zones and automatic review at the end of each cycle.",
    "plugin.install_label": "Install",
    "plugin.view_github": "View on GitHub",
    "plugin.docs": "Documentation",
  },

  // ═══════════════════════════ FRENCH ═══════════════════════════
  fr: {
    "nav.docs": "Docs",
    "nav.changelog": "Changelog",
    "nav.community": "Communauté",
    "nav.github": "GitHub",
    "header.download": "Télécharger pour Windows",
    "hero.tagline": "Le terminal conçu pour",
    "hero.word1": "Claude Code",
    "hero.word2": "les agents IA",
    "hero.word3": "le multitasking",
    "hero.word4": "Windows",
    "hero.desc":
      "Application Windows basée sur Electron. Onglets verticaux, notifications quand les agents ont besoin d'attention, panneaux divisés, navigateur intégré et une API pipe pour l'automatisation.",
    "hero.download": "Télécharger pour Windows",
    "hero.github": "Voir sur GitHub",
    "features.title": "Fonctionnalités",
    "f1.name": "Intégration passive Claude Code",
    "f1.desc":
      'wmux observe Claude Code sans modifier son comportement. Un proxy CDP sur <code>localhost:9222</code> permet au navigateur intégré de montrer chaque action en temps réel. Les hooks auto-configurés rapportent l\'activité des agents et outils dans la barre latérale. Zéro configuration.',
    "f2.name": "Navigateur intégré",
    "f2.desc":
      'ouvrez un navigateur à côté de votre terminal avec une API scriptable. Quand Claude Code navigue via <code>chrome-devtools-mcp</code>, chaque page, clic et formulaire est visible dans le panneau navigateur.',
    "f3.name": "Anneaux de notification",
    "f3.desc":
      "les panneaux s'illuminent en bleu quand les agents ont besoin d'attention. Notification Windows toast, flash barre des tâches, et centre de notifications intégré.",
    "f4.name": "Onglets verticaux",
    "f4.desc":
      "la barre latérale affiche la branche git, le répertoire de travail, les ports, le nombre d'agents, le statut PR et le texte de notification. Double-clic pour renommer.",
    "f5.name": "Panneaux divisés",
    "f5.desc":
      "divisions horizontales et verticales dans chaque onglet. Ctrl+D pour diviser à droite, Ctrl+Shift+D pour diviser en bas.",
    "f6.name": "Indicateurs d'activité",
    "f6.desc":
      "orange pulsant = en cours, vert = terminé, rouge = interrompu. Visible d'un coup d'œil dans la barre latérale.",
    "f7.name": "Sessions sauvegardées",
    "f7.desc":
      "sauvegardez vos splits, répertoires et URL navigateur. Restauration automatique au démarrage.",
    "f8.name": "Scriptable",
    "f8.desc":
      'CLI et API named pipe (<code>\\\\.\\pipe\\wmux</code>) pour l\'automatisation et le scripting. Protocole JSON-RPC v2 compatible avec cmux.',
    "f9.name": "Natif Windows",
    "f9.desc":
      "ConPTY pour l'émulation de terminal, notifications toast Windows, flash barre des tâches, title bar overlay native.",
    "f10.name": "Accélération GPU",
    "f10.desc":
      "propulsé par xterm.js avec rendu WebGL pour un affichage fluide.",
    "f11.name": "Thèmes compatibles",
    "f11.desc":
      "importez vos thèmes depuis Windows Terminal ou Ghostty. 450+ thèmes Ghostty inclus.",
    "f12.name": "Raccourcis clavier",
    "f12.desc":
      "raccourcis complets pour les espaces de travail, les divisions, le navigateur et plus.",
    "faq.title": "Questions fréquentes",
    "faq1.q": "Quelle est la relation entre wmux et cmux ?",
    "faq1.a":
      'wmux est un fork Windows de <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>. cmux est une application macOS native (Swift + AppKit + Ghostty). wmux reproduit la même expérience sur Windows en utilisant Electron + xterm.js + ConPTY. Le protocole CLI/pipe est compatible entre les deux.',
    "faq2.q": "Quelles plateformes sont supportées ?",
    "faq2.a":
      'Windows 10 et 11 uniquement (x64). Pour macOS, utilisez <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>. Pour Linux, le projet peut théoriquement être compilé depuis les sources mais ce n\'est pas officiellement supporté.',
    "faq3.q": "Quels agents sont compatibles ?",
    "faq3.a":
      "wmux est optimisé pour Claude Code avec intégration passive automatique (hooks, CDP proxy, CLAUDE.md). Tout agent ou programme en ligne de commande peut être utilisé dans les terminaux wmux — Codex, Gemini CLI, Aider, OpenCode, ou n'importe quel script.",
    "faq4.q": "Comment fonctionnent les notifications ?",
    "faq4.a":
      'Les scripts d\'intégration shell détectent quand une commande se termine ou est interrompue. Le panneau reçoit un anneau bleu, le badge sidebar s\'incrémente, et une notification Windows toast apparaît. Supporte OSC 9/99/777, la CLI <code>wmux notify</code>, et la détection d\'inactivité.',
    "faq5.q": "En quoi c'est différent de Windows Terminal ?",
    "faq5.a":
      "Windows Terminal est un excellent émulateur de terminal, mais il n'a pas de système de notification, pas de visibilité sur l'activité des agents, pas de navigateur intégré, et pas de métadonnées live (branche git, ports, PR) dans les onglets. wmux est conçu spécifiquement pour superviser des agents IA.",
    "faq6.q": "C'est gratuit ?",
    "faq6.a":
      'Oui. wmux est open-source sous licence AGPL-3.0. Téléchargement gratuit sur <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Télécharger pour Windows",
    "cta.github": "Voir sur GitHub",
    "footer.product": "Produit",
    "footer.changelog": "Changelog",
    "footer.community": "Communauté",
    "footer.releases": "Releases",
    "footer.resources": "Ressources",
    "footer.docs": "Documentation",
    "footer.install": "Installation",
    "footer.shortcuts": "Raccourcis",
    "footer.legal": "Légal",
    "footer.license": "Licence AGPL-3.0",
    "footer.social": "Social",
    "footer.copyright": "© 2026 wmux",
    "footer.fork": "Fork Windows de",
    "plugin.badge": "Plugin Claude Code",
    "plugin.desc": "Lancez plusieurs agents Claude Code en parallèle depuis une seule commande. Le plugin analyse votre codebase, découpe la tâche en sous-tâches indépendantes, et les distribue en vagues avec gestion des dépendances, zones de fichiers isolées et revue automatique en fin de cycle.",
    "plugin.install_label": "Installation",
    "plugin.view_github": "Voir sur GitHub",
    "plugin.docs": "Documentation",
  },

  // ═══════════════════════════ SPANISH ═══════════════════════════
  es: {
    "nav.docs": "Docs",
    "nav.changelog": "Cambios",
    "nav.community": "Comunidad",
    "nav.github": "GitHub",
    "header.download": "Descargar para Windows",
    "hero.tagline": "La terminal diseñada para",
    "hero.word1": "Claude Code",
    "hero.word2": "agentes IA",
    "hero.word3": "multitarea",
    "hero.word4": "Windows",
    "hero.desc":
      "Aplicación Windows basada en Electron. Pestañas verticales, notificaciones cuando los agentes necesitan atención, paneles divididos, navegador integrado y una API pipe para automatización.",
    "hero.download": "Descargar para Windows",
    "hero.github": "Ver en GitHub",
    "features.title": "Características",
    "f1.name": "Integración pasiva con Claude Code",
    "f1.desc":
      'wmux observa Claude Code sin modificar su comportamiento. Un proxy CDP en <code>localhost:9222</code> permite al navegador integrado mostrar cada acción en tiempo real. Los hooks autoconfigurados reportan la actividad de agentes y herramientas en la barra lateral. Cero configuración.',
    "f2.name": "Navegador integrado",
    "f2.desc":
      'abre un navegador junto a tu terminal con una API scriptable. Cuando Claude Code navega vía <code>chrome-devtools-mcp</code>, cada página, clic y formulario es visible en el panel del navegador.',
    "f3.name": "Anillos de notificación",
    "f3.desc":
      "los paneles se iluminan en azul cuando los agentes necesitan atención. Notificación toast de Windows, flash de barra de tareas y centro de notificaciones integrado.",
    "f4.name": "Pestañas verticales",
    "f4.desc":
      "la barra lateral muestra la rama git, el directorio de trabajo, los puertos, el número de agentes, el estado del PR y el texto de notificación. Doble clic para renombrar.",
    "f5.name": "Paneles divididos",
    "f5.desc":
      "divisiones horizontales y verticales en cada pestaña. Ctrl+D para dividir a la derecha, Ctrl+Shift+D para dividir abajo.",
    "f6.name": "Indicadores de actividad",
    "f6.desc":
      "naranja pulsante = trabajando, verde = terminado, rojo = interrumpido. Visible de un vistazo en la barra lateral.",
    "f7.name": "Sesiones guardadas",
    "f7.desc":
      "guarda tus divisiones, directorios y URL del navegador. Restauración automática al inicio.",
    "f8.name": "Scriptable",
    "f8.desc":
      'CLI y API named pipe (<code>\\\\.\\pipe\\wmux</code>) para automatización y scripting. Protocolo JSON-RPC v2 compatible con cmux.',
    "f9.name": "Nativo de Windows",
    "f9.desc":
      "ConPTY para emulación de terminal, notificaciones toast de Windows, flash de barra de tareas, title bar overlay nativo.",
    "f10.name": "Aceleración GPU",
    "f10.desc":
      "potenciado por xterm.js con renderizado WebGL para una visualización fluida.",
    "f11.name": "Temas compatibles",
    "f11.desc":
      "importa tus temas desde Windows Terminal o Ghostty. 450+ temas Ghostty incluidos.",
    "f12.name": "Atajos de teclado",
    "f12.desc":
      "atajos completos para espacios de trabajo, divisiones, navegador y más.",
    "faq.title": "Preguntas frecuentes",
    "faq1.q": "¿Cuál es la relación entre wmux y cmux?",
    "faq1.a":
      'wmux es un fork de Windows de <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>. cmux es una app nativa de macOS (Swift + AppKit + Ghostty). wmux reproduce la misma experiencia en Windows usando Electron + xterm.js + ConPTY. El protocolo CLI/pipe es compatible entre ambos.',
    "faq2.q": "¿Qué plataformas son compatibles?",
    "faq2.a":
      'Solo Windows 10 y 11 (x64). Para macOS, usa <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>. Para Linux, el proyecto puede compilarse desde el código fuente pero no es oficialmente soportado.',
    "faq3.q": "¿Qué agentes son compatibles?",
    "faq3.a":
      "wmux está optimizado para Claude Code con integración pasiva automática (hooks, proxy CDP, CLAUDE.md). Cualquier agente o programa de línea de comandos puede usarse en los terminales wmux — Codex, Gemini CLI, Aider, OpenCode o cualquier script.",
    "faq4.q": "¿Cómo funcionan las notificaciones?",
    "faq4.a":
      'Los scripts de integración shell detectan cuándo un comando termina o es interrumpido. El panel recibe un anillo azul, el badge de la barra lateral se incrementa y aparece una notificación toast de Windows. Soporta OSC 9/99/777, la CLI <code>wmux notify</code> y detección de inactividad.',
    "faq5.q": "¿En qué se diferencia de Windows Terminal?",
    "faq5.a":
      "Windows Terminal es un excelente emulador de terminal, pero no tiene sistema de notificaciones, ni visibilidad de actividad de agentes, ni navegador integrado, ni metadatos en vivo (rama git, puertos, PR) en las pestañas. wmux está diseñado específicamente para supervisar agentes IA.",
    "faq6.q": "¿Es gratis?",
    "faq6.a":
      'Sí. wmux es open-source bajo licencia AGPL-3.0. Descarga gratuita en <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Descargar para Windows",
    "cta.github": "Ver en GitHub",
    "footer.product": "Producto",
    "footer.changelog": "Cambios",
    "footer.community": "Comunidad",
    "footer.releases": "Releases",
    "footer.resources": "Recursos",
    "footer.docs": "Documentación",
    "footer.install": "Instalación",
    "footer.shortcuts": "Atajos",
    "footer.legal": "Legal",
    "footer.license": "Licencia AGPL-3.0",
    "footer.social": "Social",
    "footer.copyright": "© 2026 wmux",
    "footer.fork": "Fork Windows de",
    "plugin.badge": "Plugin Claude Code",
    "plugin.desc": "Ejecuta múltiples agentes Claude Code en paralelo con un solo comando. El plugin analiza tu código, divide la tarea en subtareas independientes y las distribuye en oleadas con gestión de dependencias, zonas de archivos aisladas y revisión automática al final de cada ciclo.",
    "plugin.install_label": "Instalación",
    "plugin.view_github": "Ver en GitHub",
    "plugin.docs": "Documentación",
  },

  // ═══════════════════════════ GERMAN ═══════════════════════════
  de: {
    "nav.docs": "Docs",
    "nav.changelog": "Änderungen",
    "nav.community": "Community",
    "nav.github": "GitHub",
    "header.download": "Für Windows herunterladen",
    "hero.tagline": "Das Terminal für",
    "hero.word1": "Claude Code",
    "hero.word2": "KI-Agenten",
    "hero.word3": "Multitasking",
    "hero.word4": "Windows",
    "hero.desc":
      "Windows-Anwendung basierend auf Electron. Vertikale Tabs, Benachrichtigungen wenn Agenten Aufmerksamkeit brauchen, geteilte Panels, integrierter Browser und eine Pipe-API für Automatisierung.",
    "hero.download": "Für Windows herunterladen",
    "hero.github": "Auf GitHub ansehen",
    "features.title": "Funktionen",
    "f1.name": "Passive Claude Code Integration",
    "f1.desc":
      'wmux beobachtet Claude Code ohne sein Verhalten zu ändern. Ein CDP-Proxy auf <code>localhost:9222</code> lässt den integrierten Browser jede Aktion in Echtzeit anzeigen. Automatisch konfigurierte Hooks melden Agenten- und Tool-Aktivität in der Seitenleiste. Null Konfiguration.',
    "f2.name": "Integrierter Browser",
    "f2.desc":
      'öffne einen Browser neben deinem Terminal mit einer skriptbaren API. Wenn Claude Code über <code>chrome-devtools-mcp</code> surft, ist jede Seite, jeder Klick und jedes Formular im Browser-Panel sichtbar.',
    "f3.name": "Benachrichtigungsringe",
    "f3.desc":
      "Panels leuchten blau auf wenn Agenten Aufmerksamkeit brauchen. Windows Toast-Benachrichtigung, Taskleisten-Flash und integriertes Benachrichtigungscenter.",
    "f4.name": "Vertikale Tabs",
    "f4.desc":
      "die Seitenleiste zeigt Git-Branch, Arbeitsverzeichnis, Ports, Agenten-Anzahl, PR-Status und Benachrichtigungstext. Doppelklick zum Umbenennen.",
    "f5.name": "Geteilte Panels",
    "f5.desc":
      "horizontale und vertikale Teilungen in jedem Tab. Strg+D zum Rechts-Teilen, Strg+Umschalt+D zum Unten-Teilen.",
    "f6.name": "Aktivitätsindikatoren",
    "f6.desc":
      "pulsierendes Orange = arbeitet, Grün = fertig, Rot = unterbrochen. Auf einen Blick in der Seitenleiste sichtbar.",
    "f7.name": "Gespeicherte Sitzungen",
    "f7.desc":
      "speichere deine Splits, Verzeichnisse und Browser-URL. Automatische Wiederherstellung beim Start.",
    "f8.name": "Skriptbar",
    "f8.desc":
      'CLI und Named-Pipe-API (<code>\\\\.\\pipe\\wmux</code>) für Automatisierung und Skripting. JSON-RPC v2 Protokoll kompatibel mit cmux.',
    "f9.name": "Windows-nativ",
    "f9.desc":
      "ConPTY für Terminal-Emulation, Windows Toast-Benachrichtigungen, Taskleisten-Flash, native Titelleisten-Overlay.",
    "f10.name": "GPU-Beschleunigung",
    "f10.desc":
      "angetrieben von xterm.js mit WebGL-Rendering für flüssige Darstellung.",
    "f11.name": "Theme-kompatibel",
    "f11.desc":
      "importiere deine Themes aus Windows Terminal oder Ghostty. 450+ mitgelieferte Ghostty-Themes.",
    "f12.name": "Tastenkürzel",
    "f12.desc":
      "vollständige Tastenkürzel für Arbeitsbereiche, Splits, Browser und mehr.",
    "faq.title": "Häufig gestellte Fragen",
    "faq1.q": "Was ist die Beziehung zwischen wmux und cmux?",
    "faq1.a":
      'wmux ist ein Windows-Fork von <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>. cmux ist eine native macOS-App (Swift + AppKit + Ghostty). wmux reproduziert die gleiche Erfahrung unter Windows mit Electron + xterm.js + ConPTY. Das CLI/Pipe-Protokoll ist zwischen beiden kompatibel.',
    "faq2.q": "Welche Plattformen werden unterstützt?",
    "faq2.a":
      'Nur Windows 10 und 11 (x64). Für macOS verwende <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>. Für Linux kann das Projekt theoretisch aus dem Quellcode gebaut werden, wird aber nicht offiziell unterstützt.',
    "faq3.q": "Welche Agenten sind kompatibel?",
    "faq3.a":
      "wmux ist für Claude Code mit automatischer passiver Integration optimiert (Hooks, CDP-Proxy, CLAUDE.md). Jeder Kommandozeilen-Agent oder jedes Programm kann in wmux-Terminals verwendet werden — Codex, Gemini CLI, Aider, OpenCode oder jedes Skript.",
    "faq4.q": "Wie funktionieren die Benachrichtigungen?",
    "faq4.a":
      'Shell-Integrationsskripte erkennen wenn ein Befehl endet oder unterbrochen wird. Das Panel bekommt einen blauen Ring, das Sidebar-Badge erhöht sich und eine Windows Toast-Benachrichtigung erscheint. Unterstützt OSC 9/99/777, die CLI <code>wmux notify</code> und Leerlauferkennung.',
    "faq5.q": "Wie unterscheidet es sich von Windows Terminal?",
    "faq5.a":
      "Windows Terminal ist ein hervorragender Terminal-Emulator, hat aber kein Benachrichtigungssystem, keine Agenten-Aktivitätssichtbarkeit, keinen integrierten Browser und keine Live-Metadaten (Git-Branch, Ports, PR) in den Tabs. wmux ist speziell für die Überwachung von KI-Agenten konzipiert.",
    "faq6.q": "Ist es kostenlos?",
    "faq6.a":
      'Ja. wmux ist Open-Source unter der AGPL-3.0-Lizenz. Kostenloser Download auf <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Für Windows herunterladen",
    "cta.github": "Auf GitHub ansehen",
    "footer.product": "Produkt",
    "footer.changelog": "Änderungen",
    "footer.community": "Community",
    "footer.releases": "Releases",
    "footer.resources": "Ressourcen",
    "footer.docs": "Dokumentation",
    "footer.install": "Installation",
    "footer.shortcuts": "Tastenkürzel",
    "footer.legal": "Rechtliches",
    "footer.license": "AGPL-3.0-Lizenz",
    "footer.social": "Social",
    "footer.copyright": "© 2026 wmux",
    "footer.fork": "Windows-Fork von",
    "plugin.badge": "Claude Code Plugin",
    "plugin.desc": "Starten Sie mehrere Claude Code-Agenten parallel mit einem einzigen Befehl. Das Plugin analysiert Ihre Codebasis, teilt die Aufgabe in unabhängige Teilaufgaben auf und verteilt sie in Wellen mit Abhängigkeitsmanagement, isolierten Dateizonen und automatischer Überprüfung am Ende jedes Zyklus.",
    "plugin.install_label": "Installation",
    "plugin.view_github": "Auf GitHub ansehen",
    "plugin.docs": "Dokumentation",
  },

  // ═══════════════════════════ PORTUGUESE ═══════════════════════════
  pt: {
    "nav.docs": "Docs",
    "nav.changelog": "Changelog",
    "nav.community": "Comunidade",
    "nav.github": "GitHub",
    "header.download": "Baixar para Windows",
    "hero.tagline": "O terminal feito para",
    "hero.word1": "Claude Code",
    "hero.word2": "agentes IA",
    "hero.word3": "multitarefa",
    "hero.word4": "Windows",
    "hero.desc":
      "Aplicação Windows baseada em Electron. Abas verticais, notificações quando os agentes precisam de atenção, painéis divididos, navegador integrado e uma API pipe para automação.",
    "hero.download": "Baixar para Windows",
    "hero.github": "Ver no GitHub",
    "features.title": "Funcionalidades",
    "f1.name": "Integração passiva com Claude Code",
    "f1.desc": 'wmux observa o Claude Code sem modificar seu comportamento. Um proxy CDP em <code>localhost:9222</code> permite ao navegador integrado mostrar cada ação em tempo real. Hooks autoconfigurados reportam atividade de agentes e ferramentas na barra lateral. Zero configuração.',
    "f2.name": "Navegador integrado",
    "f2.desc": 'abra um navegador ao lado do seu terminal com uma API scriptável. Quando o Claude Code navega via <code>chrome-devtools-mcp</code>, cada página, clique e formulário é visível no painel do navegador.',
    "f3.name": "Anéis de notificação",
    "f3.desc": "os painéis brilham em azul quando os agentes precisam de atenção. Notificação toast do Windows, flash da barra de tarefas e centro de notificações integrado.",
    "f4.name": "Abas verticais",
    "f4.desc": "a barra lateral mostra branch git, diretório de trabalho, portas, contagem de agentes, status do PR e texto de notificação. Duplo clique para renomear.",
    "f5.name": "Painéis divididos",
    "f5.desc": "divisões horizontais e verticais em cada aba. Ctrl+D para dividir à direita, Ctrl+Shift+D para dividir abaixo.",
    "f6.name": "Indicadores de atividade",
    "f6.desc": "laranja pulsante = trabalhando, verde = concluído, vermelho = interrompido. Visível rapidamente na barra lateral.",
    "f7.name": "Sessões salvas",
    "f7.desc": "salve suas divisões, diretórios e URL do navegador. Restauração automática na inicialização.",
    "f8.name": "Scriptável",
    "f8.desc": 'CLI e API named pipe (<code>\\\\.\\pipe\\wmux</code>) para automação e scripting. Protocolo JSON-RPC v2 compatível com cmux.',
    "f9.name": "Nativo Windows",
    "f9.desc": "ConPTY para emulação de terminal, notificações toast do Windows, flash da barra de tarefas, title bar overlay nativo.",
    "f10.name": "Aceleração GPU",
    "f10.desc": "alimentado por xterm.js com renderização WebGL para exibição fluida.",
    "f11.name": "Temas compatíveis",
    "f11.desc": "importe seus temas do Windows Terminal ou Ghostty. 450+ temas Ghostty incluídos.",
    "f12.name": "Atalhos de teclado",
    "f12.desc": "atalhos completos para workspaces, divisões, navegador e mais.",
    "faq.title": "Perguntas frequentes",
    "faq1.q": "Qual é a relação entre wmux e cmux?",
    "faq1.a": 'wmux é um fork Windows de <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>. cmux é um app nativo macOS (Swift + AppKit + Ghostty). wmux reproduz a mesma experiência no Windows usando Electron + xterm.js + ConPTY. O protocolo CLI/pipe é compatível entre os dois.',
    "faq2.q": "Quais plataformas são suportadas?",
    "faq2.a": 'Apenas Windows 10 e 11 (x64). Para macOS, use <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>. Para Linux, o projeto pode ser compilado a partir do código-fonte mas não é oficialmente suportado.',
    "faq3.q": "Quais agentes são compatíveis?",
    "faq3.a": "wmux é otimizado para Claude Code com integração passiva automática (hooks, proxy CDP, CLAUDE.md). Qualquer agente ou programa de linha de comando pode ser usado nos terminais wmux — Codex, Gemini CLI, Aider, OpenCode ou qualquer script.",
    "faq4.q": "Como funcionam as notificações?",
    "faq4.a": 'Scripts de integração shell detectam quando um comando termina ou é interrompido. O painel recebe um anel azul, o badge da sidebar incrementa e uma notificação toast do Windows aparece. Suporta OSC 9/99/777, a CLI <code>wmux notify</code> e detecção de inatividade.',
    "faq5.q": "Qual a diferença para o Windows Terminal?",
    "faq5.a": "Windows Terminal é um excelente emulador de terminal, mas não tem sistema de notificações, visibilidade de atividade de agentes, navegador integrado ou metadados em tempo real (branch git, portas, PR) nas abas. wmux é projetado especificamente para supervisionar agentes IA.",
    "faq6.q": "É grátis?",
    "faq6.a": 'Sim. wmux é open-source sob licença AGPL-3.0. Download gratuito em <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Baixar para Windows",
    "cta.github": "Ver no GitHub",
    "footer.product": "Produto",
    "footer.changelog": "Changelog",
    "footer.community": "Comunidade",
    "footer.releases": "Releases",
    "footer.resources": "Recursos",
    "footer.docs": "Documentação",
    "footer.install": "Instalação",
    "footer.shortcuts": "Atalhos",
    "footer.legal": "Legal",
    "footer.license": "Licença AGPL-3.0",
    "footer.social": "Social",
    "footer.copyright": "© 2026 wmux",
    "footer.fork": "Fork Windows de",
    "plugin.badge": "Plugin Claude Code",
    "plugin.desc": "Execute vários agentes Claude Code em paralelo com um único comando. O plugin analisa sua base de código, divide a tarefa em subtarefas independentes e as distribui em ondas com gerenciamento de dependências, zonas de arquivo isoladas e revisão automática ao final de cada ciclo.",
    "plugin.install_label": "Instalação",
    "plugin.view_github": "Ver no GitHub",
    "plugin.docs": "Documentação",
  },

  // ═══════════════════════════ ITALIAN ═══════════════════════════
  it: {
    "nav.docs": "Docs",
    "nav.changelog": "Changelog",
    "nav.community": "Comunità",
    "nav.github": "GitHub",
    "header.download": "Scarica per Windows",
    "hero.tagline": "Il terminale progettato per",
    "hero.word1": "Claude Code",
    "hero.word2": "agenti IA",
    "hero.word3": "il multitasking",
    "hero.word4": "Windows",
    "hero.desc": "Applicazione Windows basata su Electron. Tab verticali, notifiche quando gli agenti necessitano attenzione, pannelli divisi, browser integrato e un'API pipe per l'automazione.",
    "hero.download": "Scarica per Windows",
    "hero.github": "Vedi su GitHub",
    "features.title": "Funzionalità",
    "f1.name": "Integrazione passiva Claude Code",
    "f1.desc": 'wmux osserva Claude Code senza modificare il suo comportamento. Un proxy CDP su <code>localhost:9222</code> permette al browser integrato di mostrare ogni azione in tempo reale. Gli hook autoconfigurati riportano l\'attività di agenti e strumenti nella barra laterale. Zero configurazione.',
    "f2.name": "Browser integrato",
    "f2.desc": 'apri un browser accanto al tuo terminale con un\'API scriptabile. Quando Claude Code naviga tramite <code>chrome-devtools-mcp</code>, ogni pagina, clic e modulo è visibile nel pannello browser.',
    "f3.name": "Anelli di notifica",
    "f3.desc": "i pannelli si illuminano di blu quando gli agenti necessitano attenzione. Notifica toast Windows, flash barra delle applicazioni e centro notifiche integrato.",
    "f4.name": "Tab verticali",
    "f4.desc": "la barra laterale mostra il branch git, la directory di lavoro, le porte, il numero di agenti, lo stato PR e il testo di notifica. Doppio clic per rinominare.",
    "f5.name": "Pannelli divisi",
    "f5.desc": "divisioni orizzontali e verticali in ogni tab. Ctrl+D per dividere a destra, Ctrl+Shift+D per dividere in basso.",
    "f6.name": "Indicatori di attività",
    "f6.desc": "arancione pulsante = in corso, verde = completato, rosso = interrotto. Visibile a colpo d'occhio nella barra laterale.",
    "f7.name": "Sessioni salvate",
    "f7.desc": "salva le tue divisioni, directory e URL del browser. Ripristino automatico all'avvio.",
    "f8.name": "Scriptabile",
    "f8.desc": 'CLI e API named pipe (<code>\\\\.\\pipe\\wmux</code>) per automazione e scripting. Protocollo JSON-RPC v2 compatibile con cmux.',
    "f9.name": "Nativo Windows",
    "f9.desc": "ConPTY per l'emulazione del terminale, notifiche toast Windows, flash barra delle applicazioni, title bar overlay nativo.",
    "f10.name": "Accelerazione GPU",
    "f10.desc": "alimentato da xterm.js con rendering WebGL per una visualizzazione fluida.",
    "f11.name": "Temi compatibili",
    "f11.desc": "importa i tuoi temi da Windows Terminal o Ghostty. 450+ temi Ghostty inclusi.",
    "f12.name": "Scorciatoie da tastiera",
    "f12.desc": "scorciatoie complete per workspace, divisioni, browser e altro.",
    "faq.title": "Domande frequenti",
    "faq1.q": "Qual è la relazione tra wmux e cmux?",
    "faq1.a": 'wmux è un fork Windows di <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>. cmux è un\'app nativa macOS (Swift + AppKit + Ghostty). wmux riproduce la stessa esperienza su Windows usando Electron + xterm.js + ConPTY. Il protocollo CLI/pipe è compatibile tra i due.',
    "faq2.q": "Quali piattaforme sono supportate?",
    "faq2.a": 'Solo Windows 10 e 11 (x64). Per macOS, usa <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>. Per Linux, il progetto può essere compilato dai sorgenti ma non è ufficialmente supportato.',
    "faq3.q": "Quali agenti sono compatibili?",
    "faq3.a": "wmux è ottimizzato per Claude Code con integrazione passiva automatica (hook, proxy CDP, CLAUDE.md). Qualsiasi agente o programma da riga di comando può essere usato nei terminali wmux — Codex, Gemini CLI, Aider, OpenCode o qualsiasi script.",
    "faq4.q": "Come funzionano le notifiche?",
    "faq4.a": 'Gli script di integrazione shell rilevano quando un comando finisce o viene interrotto. Il pannello riceve un anello blu, il badge della sidebar si incrementa e appare una notifica toast Windows. Supporta OSC 9/99/777, la CLI <code>wmux notify</code> e il rilevamento di inattività.',
    "faq5.q": "In cosa si differenzia da Windows Terminal?",
    "faq5.a": "Windows Terminal è un eccellente emulatore di terminale, ma non ha un sistema di notifiche, visibilità sull'attività degli agenti, browser integrato o metadati live (branch git, porte, PR) nei tab. wmux è progettato specificamente per supervisionare agenti IA.",
    "faq6.q": "È gratuito?",
    "faq6.a": 'Sì. wmux è open-source sotto licenza AGPL-3.0. Download gratuito su <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Scarica per Windows",
    "cta.github": "Vedi su GitHub",
    "footer.product": "Prodotto",
    "footer.changelog": "Changelog",
    "footer.community": "Comunità",
    "footer.releases": "Releases",
    "footer.resources": "Risorse",
    "footer.docs": "Documentazione",
    "footer.install": "Installazione",
    "footer.shortcuts": "Scorciatoie",
    "footer.legal": "Legale",
    "footer.license": "Licenza AGPL-3.0",
    "footer.social": "Social",
    "footer.copyright": "© 2026 wmux",
    "footer.fork": "Fork Windows di",
    "plugin.badge": "Plugin Claude Code",
    "plugin.desc": "Avvia più agenti Claude Code in parallelo con un singolo comando. Il plugin analizza il tuo codice, suddivide il compito in sotto-attività indipendenti e le distribuisce a ondate con gestione delle dipendenze, zone di file isolate e revisione automatica alla fine di ogni ciclo.",
    "plugin.install_label": "Installazione",
    "plugin.view_github": "Vedi su GitHub",
    "plugin.docs": "Documentazione",
  },

  // ═══════════════════════════ DUTCH ═══════════════════════════
  nl: {
    "nav.docs": "Docs", "nav.changelog": "Changelog", "nav.community": "Community", "nav.github": "GitHub",
    "header.download": "Downloaden voor Windows",
    "hero.tagline": "De terminal gebouwd voor", "hero.word1": "Claude Code", "hero.word2": "AI-agenten", "hero.word3": "multitasking", "hero.word4": "Windows",
    "hero.desc": "Windows-applicatie gebouwd op Electron. Verticale tabbladen, meldingen wanneer agenten aandacht nodig hebben, gesplitste panelen, ingebouwde browser en een pipe-API voor automatisering.",
    "hero.download": "Downloaden voor Windows", "hero.github": "Bekijk op GitHub",
    "features.title": "Functies",
    "f1.name": "Passieve Claude Code integratie", "f1.desc": 'wmux observeert Claude Code zonder het gedrag te wijzigen. Een CDP-proxy op <code>localhost:9222</code> laat de ingebouwde browser elke actie in realtime tonen. Automatisch geconfigureerde hooks rapporteren agent- en tool-activiteit in de zijbalk. Nul configuratie.',
    "f2.name": "Ingebouwde browser", "f2.desc": 'open een browser naast je terminal met een scriptbare API. Wanneer Claude Code navigeert via <code>chrome-devtools-mcp</code>, is elke pagina, klik en formulier zichtbaar in het browserpaneel.',
    "f3.name": "Notificatieringen", "f3.desc": "panelen lichten blauw op wanneer agenten aandacht nodig hebben. Windows toast-melding, taakbalk-flash en ingebouwd meldingscentrum.",
    "f4.name": "Verticale tabbladen", "f4.desc": "de zijbalk toont git-branch, werkmap, poorten, aantal agenten, PR-status en meldingstekst. Dubbelklik om te hernoemen.",
    "f5.name": "Gesplitste panelen", "f5.desc": "horizontale en verticale splitsingen in elk tabblad. Ctrl+D om rechts te splitsen, Ctrl+Shift+D om onder te splitsen.",
    "f6.name": "Activiteitsindicatoren", "f6.desc": "pulserend oranje = bezig, groen = klaar, rood = onderbroken. In één oogopslag zichtbaar in de zijbalk.",
    "f7.name": "Opgeslagen sessies", "f7.desc": "sla je splitsingen, mappen en browser-URL op. Automatisch herstel bij opstarten.",
    "f8.name": "Scriptbaar", "f8.desc": 'CLI en named pipe API (<code>\\\\.\\pipe\\wmux</code>) voor automatisering en scripting. JSON-RPC v2 protocol compatibel met cmux.',
    "f9.name": "Windows-natief", "f9.desc": "ConPTY voor terminal-emulatie, Windows toast-meldingen, taakbalk-flash, native titelbalk-overlay.",
    "f10.name": "GPU-versnelling", "f10.desc": "aangedreven door xterm.js met WebGL-rendering voor vloeiende weergave.",
    "f11.name": "Thema-compatibel", "f11.desc": "importeer je thema's uit Windows Terminal of Ghostty. 450+ meegeleverde Ghostty-thema's.",
    "f12.name": "Sneltoetsen", "f12.desc": "volledige sneltoetsen voor werkruimtes, splitsingen, browser en meer.",
    "faq.title": "Veelgestelde vragen",
    "faq1.q": "Wat is de relatie tussen wmux en cmux?", "faq1.a": 'wmux is een Windows-fork van <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>. cmux is een native macOS-app (Swift + AppKit + Ghostty). wmux reproduceert dezelfde ervaring op Windows met Electron + xterm.js + ConPTY.',
    "faq2.q": "Welke platformen worden ondersteund?", "faq2.a": 'Alleen Windows 10 en 11 (x64). Voor macOS gebruik <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>.',
    "faq3.q": "Welke agenten zijn compatibel?", "faq3.a": "wmux is geoptimaliseerd voor Claude Code. Elke commandoregel-agent kan worden gebruikt — Codex, Gemini CLI, Aider, OpenCode of elk script.",
    "faq4.q": "Hoe werken de meldingen?", "faq4.a": 'Shell-integratiescripts detecteren wanneer een commando eindigt of wordt onderbroken. Het paneel krijgt een blauwe ring, de sidebar-badge wordt verhoogd en een Windows toast-melding verschijnt. Ondersteunt OSC 9/99/777, de CLI <code>wmux notify</code> en inactiviteitsdetectie.',
    "faq5.q": "Hoe verschilt het van Windows Terminal?", "faq5.a": "Windows Terminal heeft geen meldingssysteem, geen agentactiviteitsweergave, geen ingebouwde browser en geen live-metadata in tabbladen. wmux is specifiek ontworpen voor het toezicht op AI-agenten.",
    "faq6.q": "Is het gratis?", "faq6.a": 'Ja. wmux is open-source onder AGPL-3.0. Gratis download op <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Downloaden voor Windows", "cta.github": "Bekijk op GitHub",
    "footer.product": "Product", "footer.changelog": "Changelog", "footer.community": "Community", "footer.releases": "Releases",
    "footer.resources": "Bronnen", "footer.docs": "Documentatie", "footer.install": "Installatie", "footer.shortcuts": "Sneltoetsen",
    "footer.legal": "Juridisch", "footer.license": "AGPL-3.0-licentie", "footer.social": "Social", "footer.copyright": "© 2026 wmux", "footer.fork": "Windows-fork van", "plugin.badge": "Claude Code Plugin", "plugin.desc": "Start meerdere Claude Code-agenten parallel vanuit één commando. De plugin analyseert je codebase, splitst de taak in onafhankelijke deeltaken en verdeelt ze in golven met afhankelijkheidsbeheer, geïsoleerde bestandszones en automatische review aan het einde van elke cyclus.", "plugin.install_label": "Installatie", "plugin.view_github": "Bekijk op GitHub", "plugin.docs": "Documentatie",
  },

  // ═══════════════════════════ POLISH ═══════════════════════════
  pl: {
    "nav.docs": "Docs", "nav.changelog": "Zmiany", "nav.community": "Społeczność", "nav.github": "GitHub",
    "header.download": "Pobierz dla Windows",
    "hero.tagline": "Terminal stworzony dla", "hero.word1": "Claude Code", "hero.word2": "agentów AI", "hero.word3": "wielozadaniowości", "hero.word4": "Windows",
    "hero.desc": "Aplikacja Windows oparta na Electron. Pionowe karty, powiadomienia gdy agenci potrzebują uwagi, podzielone panele, wbudowana przeglądarka i API pipe do automatyzacji.",
    "hero.download": "Pobierz dla Windows", "hero.github": "Zobacz na GitHub",
    "features.title": "Funkcje",
    "f1.name": "Pasywna integracja z Claude Code", "f1.desc": 'wmux obserwuje Claude Code bez modyfikowania jego zachowania. Proxy CDP na <code>localhost:9222</code> pozwala wbudowanej przeglądarce pokazywać każdą akcję w czasie rzeczywistym. Zero konfiguracji.',
    "f2.name": "Wbudowana przeglądarka", "f2.desc": 'otwórz przeglądarkę obok terminala ze skryptowalnym API. Gdy Claude Code nawiguje przez <code>chrome-devtools-mcp</code>, każda strona, kliknięcie i formularz jest widoczny.',
    "f3.name": "Pierścienie powiadomień", "f3.desc": "panele świecą na niebiesko gdy agenci potrzebują uwagi. Powiadomienia toast Windows, flash paska zadań i wbudowane centrum powiadomień.",
    "f4.name": "Pionowe karty", "f4.desc": "pasek boczny wyświetla branch git, katalog roboczy, porty, liczbę agentów, status PR i tekst powiadomienia.",
    "f5.name": "Podzielone panele", "f5.desc": "podziały poziome i pionowe w każdej karcie. Ctrl+D aby podzielić w prawo, Ctrl+Shift+D aby podzielić w dół.",
    "f6.name": "Wskaźniki aktywności", "f6.desc": "pulsujący pomarańczowy = pracuje, zielony = gotowe, czerwony = przerwane.",
    "f7.name": "Zapisane sesje", "f7.desc": "zapisz swoje podziały, katalogi i URL przeglądarki. Automatyczne przywracanie przy uruchomieniu.",
    "f8.name": "Skryptowalny", "f8.desc": 'CLI i API named pipe (<code>\\\\.\\pipe\\wmux</code>) do automatyzacji i skryptów. Protokół JSON-RPC v2 kompatybilny z cmux.',
    "f9.name": "Natywny Windows", "f9.desc": "ConPTY do emulacji terminala, powiadomienia toast Windows, flash paska zadań.",
    "f10.name": "Akceleracja GPU", "f10.desc": "napędzany przez xterm.js z renderowaniem WebGL.",
    "f11.name": "Kompatybilne motywy", "f11.desc": "importuj motywy z Windows Terminal lub Ghostty. 450+ motywów Ghostty w zestawie.",
    "f12.name": "Skróty klawiszowe", "f12.desc": "pełne skróty dla przestrzeni roboczych, podziałów, przeglądarki i więcej.",
    "faq.title": "Często zadawane pytania",
    "faq1.q": "Jaka jest relacja między wmux a cmux?", "faq1.a": 'wmux to fork Windows projektu <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>. cmux to natywna aplikacja macOS. wmux odtwarza to samo doświadczenie na Windows.',
    "faq2.q": "Jakie platformy są obsługiwane?", "faq2.a": 'Tylko Windows 10 i 11 (x64). Dla macOS użyj <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>.',
    "faq3.q": "Jakie agenty są kompatybilne?", "faq3.a": "wmux jest zoptymalizowany dla Claude Code. Każdy agent wiersza poleceń może być używany — Codex, Gemini CLI, Aider, OpenCode lub dowolny skrypt.",
    "faq4.q": "Jak działają powiadomienia?", "faq4.a": 'Skrypty integracji shell wykrywają zakończenie lub przerwanie polecenia. Panel otrzymuje niebieski pierścień, badge paska bocznego się zwiększa i pojawia się powiadomienie toast. Obsługuje OSC 9/99/777 i CLI <code>wmux notify</code>.',
    "faq5.q": "Czym się różni od Windows Terminal?", "faq5.a": "Windows Terminal nie ma systemu powiadomień, widoczności agentów, wbudowanej przeglądarki ani metadanych na żywo. wmux jest zaprojektowany do nadzorowania agentów AI.",
    "faq6.q": "Czy jest darmowy?", "faq6.a": 'Tak. wmux jest open-source na licencji AGPL-3.0. Darmowe pobieranie na <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Pobierz dla Windows", "cta.github": "Zobacz na GitHub",
    "footer.product": "Produkt", "footer.changelog": "Zmiany", "footer.community": "Społeczność", "footer.releases": "Wydania",
    "footer.resources": "Zasoby", "footer.docs": "Dokumentacja", "footer.install": "Instalacja", "footer.shortcuts": "Skróty",
    "footer.legal": "Prawne", "footer.license": "Licencja AGPL-3.0", "footer.social": "Social", "footer.copyright": "© 2026 wmux", "footer.fork": "Fork Windows projektu", "plugin.badge": "Plugin Claude Code", "plugin.desc": "Uruchom wielu agentów Claude Code równolegle jednym poleceniem. Plugin analizuje bazę kodu, dzieli zadanie na niezależne podzadania i rozdziela je falami z zarządzaniem zależnościami, izolowanymi strefami plików i automatycznym przeglądem na końcu każdego cyklu.", "plugin.install_label": "Instalacja", "plugin.view_github": "Zobacz na GitHub", "plugin.docs": "Dokumentacja",
  },

  // ═══════════════════════════ TURKISH ═══════════════════════════
  tr: {
    "nav.docs": "Docs", "nav.changelog": "Değişiklikler", "nav.community": "Topluluk", "nav.github": "GitHub",
    "header.download": "Windows için indir",
    "hero.tagline": "Şunun için tasarlanan terminal:", "hero.word1": "Claude Code", "hero.word2": "yapay zeka ajanları", "hero.word3": "çoklu görev", "hero.word4": "Windows",
    "hero.desc": "Electron tabanlı Windows uygulaması. Dikey sekmeler, ajanlar ilgi istediğinde bildirimler, bölünmüş paneller, yerleşik tarayıcı ve otomasyon için pipe API.",
    "hero.download": "Windows için indir", "hero.github": "GitHub'da görüntüle",
    "features.title": "Özellikler",
    "f1.name": "Pasif Claude Code entegrasyonu", "f1.desc": 'wmux, Claude Code\'u davranışını değiştirmeden gözlemler. <code>localhost:9222</code> üzerindeki CDP proxy\'si her eylemi gerçek zamanlı gösterir. Sıfır yapılandırma.',
    "f2.name": "Yerleşik tarayıcı", "f2.desc": 'terminalinizin yanında scriptlenebilir API ile bir tarayıcı açın. Claude Code <code>chrome-devtools-mcp</code> ile gezindiğinde her sayfa, tıklama ve form tarayıcı panelinde görünür.',
    "f3.name": "Bildirim halkaları", "f3.desc": "ajanlar ilgi istediğinde paneller mavi yanar. Windows toast bildirimi, görev çubuğu flash ve yerleşik bildirim merkezi.",
    "f4.name": "Dikey sekmeler", "f4.desc": "kenar çubuğu git branch, çalışma dizini, portlar, ajan sayısı, PR durumu ve bildirim metnini gösterir.",
    "f5.name": "Bölünmüş paneller", "f5.desc": "her sekmede yatay ve dikey bölmeler. Sağa bölmek için Ctrl+D, aşağı bölmek için Ctrl+Shift+D.",
    "f6.name": "Aktivite göstergeleri", "f6.desc": "titreşen turuncu = çalışıyor, yeşil = tamamlandı, kırmızı = kesildi.",
    "f7.name": "Kayıtlı oturumlar", "f7.desc": "bölmelerinizi, dizinlerinizi ve tarayıcı URL'nizi kaydedin. Başlangıçta otomatik geri yükleme.",
    "f8.name": "Scriptlenebilir", "f8.desc": 'CLI ve named pipe API (<code>\\\\.\\pipe\\wmux</code>) otomasyon ve scripting için. cmux ile uyumlu JSON-RPC v2 protokolü.',
    "f9.name": "Windows doğal", "f9.desc": "terminal emülasyonu için ConPTY, Windows toast bildirimleri, görev çubuğu flash.",
    "f10.name": "GPU hızlandırma", "f10.desc": "akıcı görüntüleme için WebGL render ile xterm.js tarafından desteklenir.",
    "f11.name": "Tema uyumlu", "f11.desc": "Windows Terminal veya Ghostty'den temalarınızı içe aktarın. 450+ Ghostty teması dahil.",
    "f12.name": "Klavye kısayolları", "f12.desc": "çalışma alanları, bölmeler, tarayıcı ve daha fazlası için tam kısayollar.",
    "faq.title": "Sık sorulan sorular",
    "faq1.q": "wmux ve cmux arasındaki ilişki nedir?", "faq1.a": 'wmux, <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>\'un Windows fork\'udur. cmux yerel macOS uygulamasıdır. wmux aynı deneyimi Windows\'ta Electron + xterm.js + ConPTY kullanarak yeniden üretir.',
    "faq2.q": "Hangi platformlar destekleniyor?", "faq2.a": 'Yalnızca Windows 10 ve 11 (x64). macOS için <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a> kullanın.',
    "faq3.q": "Hangi ajanlar uyumlu?", "faq3.a": "wmux, Claude Code için optimize edilmiştir. Herhangi bir komut satırı ajanı kullanılabilir — Codex, Gemini CLI, Aider, OpenCode veya herhangi bir script.",
    "faq4.q": "Bildirimler nasıl çalışır?", "faq4.a": 'Shell entegrasyon scriptleri bir komutun bittiğini veya kesildiğini algılar. Panel mavi halka alır, kenar çubuğu rozeti artar ve Windows toast bildirimi görünür. OSC 9/99/777, <code>wmux notify</code> CLI ve boşta algılamayı destekler.',
    "faq5.q": "Windows Terminal'den farkı nedir?", "faq5.a": "Windows Terminal\'de bildirim sistemi, ajan aktivite görünürlüğü, yerleşik tarayıcı ve canlı metadata yoktur. wmux özellikle AI ajanlarını denetlemek için tasarlanmıştır.",
    "faq6.q": "Ücretsiz mi?", "faq6.a": 'Evet. wmux AGPL-3.0 lisansı altında açık kaynaklıdır. <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>\'tan ücretsiz indirin.',
    "cta.download": "Windows için indir", "cta.github": "GitHub'da görüntüle",
    "footer.product": "Ürün", "footer.changelog": "Değişiklikler", "footer.community": "Topluluk", "footer.releases": "Sürümler",
    "footer.resources": "Kaynaklar", "footer.docs": "Belgeler", "footer.install": "Kurulum", "footer.shortcuts": "Kısayollar",
    "footer.legal": "Hukuki", "footer.license": "AGPL-3.0 Lisansı", "footer.social": "Sosyal", "footer.copyright": "© 2026 wmux", "footer.fork": "Şunun Windows fork'u:", "plugin.badge": "Claude Code Eklentisi", "plugin.desc": "Tek bir komutla birden fazla Claude Code ajanını paralel olarak başlatın. Eklenti kod tabanınızı analiz eder, görevi bağımsız alt görevlere böler ve bunları bağımlılık yönetimi, izole dosya bölgeleri ve her döngü sonunda otomatik inceleme ile dalgalar halinde dağıtır.", "plugin.install_label": "Kurulum", "plugin.view_github": "GitHub'da Görüntüle", "plugin.docs": "Dokümantasyon",
  },

  // ═══════════════════════════ RUSSIAN ═══════════════════════════
  ru: {
    "nav.docs": "Документация", "nav.changelog": "Изменения", "nav.community": "Сообщество", "nav.github": "GitHub",
    "header.download": "Скачать для Windows",
    "hero.tagline": "Терминал, созданный для", "hero.word1": "Claude Code", "hero.word2": "ИИ-агентов", "hero.word3": "многозадачности", "hero.word4": "Windows",
    "hero.desc": "Приложение для Windows на базе Electron. Вертикальные вкладки, уведомления когда агентам нужно внимание, разделённые панели, встроенный браузер и API через пайп для автоматизации.",
    "hero.download": "Скачать для Windows", "hero.github": "Смотреть на GitHub",
    "features.title": "Возможности",
    "f1.name": "Пассивная интеграция с Claude Code", "f1.desc": 'wmux наблюдает за Claude Code не изменяя его поведение. CDP-прокси на <code>localhost:9222</code> позволяет встроенному браузеру показывать каждое действие в реальном времени. Нулевая настройка.',
    "f2.name": "Встроенный браузер", "f2.desc": 'откройте браузер рядом с терминалом со скриптовым API. Когда Claude Code просматривает через <code>chrome-devtools-mcp</code>, каждая страница, клик и форма видны в панели браузера.',
    "f3.name": "Кольца уведомлений", "f3.desc": "панели подсвечиваются синим когда агентам нужно внимание. Toast-уведомления Windows, мигание панели задач и встроенный центр уведомлений.",
    "f4.name": "Вертикальные вкладки", "f4.desc": "боковая панель показывает ветку git, рабочий каталог, порты, количество агентов, статус PR и текст уведомления.",
    "f5.name": "Разделённые панели", "f5.desc": "горизонтальные и вертикальные разделения в каждой вкладке. Ctrl+D для разделения вправо, Ctrl+Shift+D вниз.",
    "f6.name": "Индикаторы активности", "f6.desc": "пульсирующий оранжевый = работает, зелёный = готово, красный = прервано.",
    "f7.name": "Сохранённые сессии", "f7.desc": "сохраняйте разделения, каталоги и URL браузера. Автоматическое восстановление при запуске.",
    "f8.name": "Скриптуемый", "f8.desc": 'CLI и API именованного канала (<code>\\\\.\\pipe\\wmux</code>) для автоматизации и скриптов. Протокол JSON-RPC v2 совместимый с cmux.',
    "f9.name": "Нативный для Windows", "f9.desc": "ConPTY для эмуляции терминала, toast-уведомления Windows, мигание панели задач.",
    "f10.name": "Ускорение GPU", "f10.desc": "работает на xterm.js с рендерингом WebGL для плавного отображения.",
    "f11.name": "Совместимость тем", "f11.desc": "импортируйте темы из Windows Terminal или Ghostty. 450+ тем Ghostty в комплекте.",
    "f12.name": "Горячие клавиши", "f12.desc": "полный набор горячих клавиш для рабочих пространств, разделений, браузера и прочего.",
    "faq.title": "Часто задаваемые вопросы",
    "faq1.q": "Какая связь между wmux и cmux?", "faq1.a": 'wmux — это форк <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a> для Windows. cmux — нативное приложение macOS. wmux воспроизводит тот же опыт на Windows используя Electron + xterm.js + ConPTY.',
    "faq2.q": "Какие платформы поддерживаются?", "faq2.a": 'Только Windows 10 и 11 (x64). Для macOS используйте <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>.',
    "faq3.q": "Какие агенты совместимы?", "faq3.a": "wmux оптимизирован для Claude Code. Любой агент командной строки может использоваться — Codex, Gemini CLI, Aider, OpenCode или любой скрипт.",
    "faq4.q": "Как работают уведомления?", "faq4.a": 'Скрипты интеграции оболочки определяют завершение или прерывание команды. Панель получает синее кольцо, бейдж боковой панели увеличивается и появляется toast-уведомление. Поддерживает OSC 9/99/777, CLI <code>wmux notify</code> и обнаружение простоя.',
    "faq5.q": "Чем отличается от Windows Terminal?", "faq5.a": "Windows Terminal не имеет системы уведомлений, видимости активности агентов, встроенного браузера и метаданных в реальном времени. wmux разработан специально для наблюдения за ИИ-агентами.",
    "faq6.q": "Это бесплатно?", "faq6.a": 'Да. wmux — open-source под лицензией AGPL-3.0. Бесплатная загрузка на <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Скачать для Windows", "cta.github": "Смотреть на GitHub",
    "footer.product": "Продукт", "footer.changelog": "Изменения", "footer.community": "Сообщество", "footer.releases": "Релизы",
    "footer.resources": "Ресурсы", "footer.docs": "Документация", "footer.install": "Установка", "footer.shortcuts": "Горячие клавиши",
    "footer.legal": "Правовая информация", "footer.license": "Лицензия AGPL-3.0", "footer.social": "Социальные сети", "footer.copyright": "© 2026 wmux", "footer.fork": "Форк Windows проекта", "plugin.badge": "Плагин Claude Code", "plugin.desc": "Запускайте несколько агентов Claude Code параллельно одной командой. Плагин анализирует кодовую базу, разбивает задачу на независимые подзадачи и распределяет их волнами с управлением зависимостями, изолированными файловыми зонами и автоматической проверкой в конце каждого цикла.", "plugin.install_label": "Установка", "plugin.view_github": "Смотреть на GitHub", "plugin.docs": "Документация",
  },

  // ═══════════════════════════ UKRAINIAN ═══════════════════════════
  uk: {
    "nav.docs": "Документація", "nav.changelog": "Зміни", "nav.community": "Спільнота", "nav.github": "GitHub",
    "header.download": "Завантажити для Windows",
    "hero.tagline": "Термінал, створений для", "hero.word1": "Claude Code", "hero.word2": "ШІ-агентів", "hero.word3": "багатозадачності", "hero.word4": "Windows",
    "hero.desc": "Застосунок для Windows на базі Electron. Вертикальні вкладки, сповіщення коли агентам потрібна увага, розділені панелі, вбудований браузер та API через пайп для автоматизації.",
    "hero.download": "Завантажити для Windows", "hero.github": "Дивитися на GitHub",
    "features.title": "Можливості",
    "f1.name": "Пасивна інтеграція з Claude Code", "f1.desc": 'wmux спостерігає за Claude Code не змінюючи його поведінку. CDP-проксі на <code>localhost:9222</code> дозволяє вбудованому браузеру показувати кожну дію в реальному часі.',
    "f2.name": "Вбудований браузер", "f2.desc": 'відкрийте браузер поруч з терміналом зі скриптовим API. Коли Claude Code переглядає через <code>chrome-devtools-mcp</code>, кожна сторінка та клік видимі в панелі браузера.',
    "f3.name": "Кільця сповіщень", "f3.desc": "панелі підсвічуються синім коли агентам потрібна увага. Toast-сповіщення Windows та центр сповіщень.",
    "f4.name": "Вертикальні вкладки", "f4.desc": "бічна панель показує гілку git, робочий каталог, порти, кількість агентів, статус PR.",
    "f5.name": "Розділені панелі", "f5.desc": "горизонтальні та вертикальні розділення в кожній вкладці.",
    "f6.name": "Індикатори активності", "f6.desc": "пульсуючий помаранчевий = працює, зелений = готово, червоний = перервано.",
    "f7.name": "Збережені сесії", "f7.desc": "зберігайте розділення, каталоги та URL браузера. Автоматичне відновлення при запуску.",
    "f8.name": "Скриптовий", "f8.desc": 'CLI та API іменованого каналу (<code>\\\\.\\pipe\\wmux</code>) для автоматизації.',
    "f9.name": "Нативний Windows", "f9.desc": "ConPTY для емуляції терміналу, toast-сповіщення Windows.",
    "f10.name": "Прискорення GPU", "f10.desc": "працює на xterm.js з рендерингом WebGL.",
    "f11.name": "Сумісність тем", "f11.desc": "імпортуйте теми з Windows Terminal або Ghostty. 450+ тем в комплекті.",
    "f12.name": "Гарячі клавіші", "f12.desc": "повний набір гарячих клавіш для робочих просторів, розділень, браузера.",
    "faq.title": "Поширені запитання",
    "faq1.q": "Який зв'язок між wmux і cmux?", "faq1.a": 'wmux — це форк <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a> для Windows.',
    "faq2.q": "Які платформи підтримуються?", "faq2.a": 'Тільки Windows 10 і 11 (x64). Для macOS використовуйте <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>.',
    "faq3.q": "Які агенти сумісні?", "faq3.a": "wmux оптимізований для Claude Code. Будь-який агент командного рядка може використовуватися.",
    "faq4.q": "Як працюють сповіщення?", "faq4.a": 'Скрипти інтеграції оболонки виявляють завершення або переривання команди. Підтримує OSC 9/99/777, CLI <code>wmux notify</code>.',
    "faq5.q": "Чим відрізняється від Windows Terminal?", "faq5.a": "wmux розроблений спеціально для спостереження за ШІ-агентами з сповіщеннями та вбудованим браузером.",
    "faq6.q": "Це безкоштовно?", "faq6.a": 'Так. wmux — open-source під ліцензією AGPL-3.0. <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Завантажити для Windows", "cta.github": "Дивитися на GitHub",
    "footer.product": "Продукт", "footer.changelog": "Зміни", "footer.community": "Спільнота", "footer.releases": "Релізи",
    "footer.resources": "Ресурси", "footer.docs": "Документація", "footer.install": "Встановлення", "footer.shortcuts": "Гарячі клавіші",
    "footer.legal": "Правова інформація", "footer.license": "Ліцензія AGPL-3.0", "footer.social": "Соціальні мережі", "footer.copyright": "© 2026 wmux", "footer.fork": "Форк Windows проєкту", "plugin.badge": "Плагін Claude Code", "plugin.desc": "Запускайте кілька агентів Claude Code паралельно однією командою. Плагін аналізує кодову базу, розбиває завдання на незалежні підзавдання та розподіляє їх хвилями з управлінням залежностями, ізольованими файловими зонами та автоматичною перевіркою наприкінці кожного циклу.", "plugin.install_label": "Встановлення", "plugin.view_github": "Переглянути на GitHub", "plugin.docs": "Документація",
  },

  // ═══════════════════════════ ARABIC ═══════════════════════════
  ar: {
    "nav.docs": "المستندات", "nav.changelog": "سجل التغييرات", "nav.community": "المجتمع", "nav.github": "GitHub",
    "header.download": "تحميل لـ Windows",
    "hero.tagline": "الطرفية المصممة لـ", "hero.word1": "Claude Code", "hero.word2": "وكلاء الذكاء الاصطناعي", "hero.word3": "تعدد المهام", "hero.word4": "Windows",
    "hero.desc": "تطبيق Windows مبني على Electron. علامات تبويب عمودية، إشعارات عندما يحتاج الوكلاء للانتباه، ألواح مقسمة، متصفح مدمج وواجهة برمجة تطبيقات أنابيب للأتمتة.",
    "hero.download": "تحميل لـ Windows", "hero.github": "عرض على GitHub",
    "features.title": "الميزات",
    "f1.name": "تكامل سلبي مع Claude Code", "f1.desc": 'يراقب wmux Claude Code دون تغيير سلوكه. بروكسي CDP على <code>localhost:9222</code> يتيح للمتصفح المدمج عرض كل إجراء في الوقت الفعلي. بدون أي إعداد.',
    "f2.name": "متصفح مدمج", "f2.desc": 'افتح متصفحًا بجوار الطرفية مع واجهة برمجة تطبيقات قابلة للبرمجة. عندما يتصفح Claude Code عبر <code>chrome-devtools-mcp</code>، كل صفحة ونقرة مرئية في لوحة المتصفح.',
    "f3.name": "حلقات الإشعارات", "f3.desc": "تتوهج الألواح باللون الأزرق عندما يحتاج الوكلاء للانتباه. إشعارات Windows ومركز إشعارات مدمج.",
    "f4.name": "علامات تبويب عمودية", "f4.desc": "الشريط الجانبي يعرض فرع git، دليل العمل، المنافذ، عدد الوكلاء وحالة PR.",
    "f5.name": "ألواح مقسمة", "f5.desc": "تقسيمات أفقية وعمودية في كل علامة تبويب. Ctrl+D للتقسيم يمينًا، Ctrl+Shift+D للتقسيم لأسفل.",
    "f6.name": "مؤشرات النشاط", "f6.desc": "برتقالي نابض = يعمل، أخضر = انتهى، أحمر = توقف.",
    "f7.name": "جلسات محفوظة", "f7.desc": "احفظ التقسيمات والأدلة وعنوان المتصفح. استعادة تلقائية عند بدء التشغيل.",
    "f8.name": "قابل للبرمجة", "f8.desc": 'CLI وواجهة أنابيب مسماة (<code>\\\\.\\pipe\\wmux</code>) للأتمتة. بروتوكول JSON-RPC v2 متوافق مع cmux.',
    "f9.name": "أصلي لـ Windows", "f9.desc": "ConPTY لمحاكاة الطرفية، إشعارات Windows، وميض شريط المهام.",
    "f10.name": "تسريع GPU", "f10.desc": "مدعوم بـ xterm.js مع عرض WebGL لعرض سلس.",
    "f11.name": "متوافق مع السمات", "f11.desc": "استورد سماتك من Windows Terminal أو Ghostty. أكثر من 450 سمة Ghostty مضمنة.",
    "f12.name": "اختصارات لوحة المفاتيح", "f12.desc": "اختصارات كاملة لمساحات العمل والتقسيمات والمتصفح والمزيد.",
    "faq.title": "الأسئلة الشائعة",
    "faq1.q": "ما العلاقة بين wmux و cmux؟", "faq1.a": 'wmux هو فرع Windows من <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>. cmux تطبيق macOS أصلي. wmux يعيد إنتاج نفس التجربة على Windows.',
    "faq2.q": "ما المنصات المدعومة؟", "faq2.a": 'Windows 10 و 11 فقط (x64). لـ macOS استخدم <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>.',
    "faq3.q": "ما الوكلاء المتوافقون؟", "faq3.a": "wmux مُحسَّن لـ Claude Code. يمكن استخدام أي وكيل سطر أوامر — Codex، Gemini CLI، Aider، OpenCode أو أي برنامج نصي.",
    "faq4.q": "كيف تعمل الإشعارات؟", "faq4.a": 'تكتشف نصوص تكامل الصدفة انتهاء أو مقاطعة الأمر. يدعم OSC 9/99/777 و <code>wmux notify</code>.',
    "faq5.q": "كيف يختلف عن Windows Terminal؟", "faq5.a": "wmux مصمم خصيصًا لمراقبة وكلاء الذكاء الاصطناعي مع إشعارات ومتصفح مدمج وبيانات وصفية حية.",
    "faq6.q": "هل هو مجاني؟", "faq6.a": 'نعم. wmux مفتوح المصدر تحت رخصة AGPL-3.0. تحميل مجاني من <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "تحميل لـ Windows", "cta.github": "عرض على GitHub",
    "footer.product": "المنتج", "footer.changelog": "سجل التغييرات", "footer.community": "المجتمع", "footer.releases": "الإصدارات",
    "footer.resources": "الموارد", "footer.docs": "التوثيق", "footer.install": "التثبيت", "footer.shortcuts": "الاختصارات",
    "footer.legal": "قانوني", "footer.license": "رخصة AGPL-3.0", "footer.social": "التواصل", "footer.copyright": "© 2026 wmux", "footer.fork": "فرع Windows من", "plugin.badge": "إضافة Claude Code", "plugin.desc": "شغّل عدة وكلاء Claude Code بالتوازي بأمر واحد. تحلل الإضافة قاعدة الشيفرة وتقسّم المهمة إلى مهام فرعية مستقلة وتوزعها على موجات مع إدارة التبعيات ومناطق ملفات معزولة ومراجعة تلقائية في نهاية كل دورة.", "plugin.install_label": "التثبيت", "plugin.view_github": "عرض على GitHub", "plugin.docs": "التوثيق",
  },

  // ═══════════════════════════ CHINESE SIMPLIFIED ═══════════════════════════
  zh: {
    "nav.docs": "文档", "nav.changelog": "更新日志", "nav.community": "社区", "nav.github": "GitHub",
    "header.download": "下载 Windows 版",
    "hero.tagline": "专为以下场景打造的终端：", "hero.word1": "Claude Code", "hero.word2": "AI 代理", "hero.word3": "多任务处理", "hero.word4": "Windows",
    "hero.desc": "基于 Electron 的 Windows 应用。垂直标签页、代理需要关注时发送通知、分屏面板、内置浏览器和用于自动化的管道 API。",
    "hero.download": "下载 Windows 版", "hero.github": "在 GitHub 上查看",
    "features.title": "功能特性",
    "f1.name": "Claude Code 被动集成", "f1.desc": 'wmux 在不改变 Claude Code 行为的情况下进行观察。<code>localhost:9222</code> 上的 CDP 代理让内置浏览器实时显示每个操作。零配置。',
    "f2.name": "内置浏览器", "f2.desc": '在终端旁打开一个可脚本化 API 的浏览器。当 Claude Code 通过 <code>chrome-devtools-mcp</code> 浏览时，每个页面、点击和表单都在浏览器面板中可见。',
    "f3.name": "通知环", "f3.desc": "当代理需要关注时面板会发蓝光。Windows toast 通知、任务栏闪烁和内置通知中心。",
    "f4.name": "垂直标签页", "f4.desc": "侧边栏显示 git 分支、工作目录、端口、代理数量、PR 状态和通知文本。",
    "f5.name": "分屏面板", "f5.desc": "每个标签页中可水平和垂直分屏。Ctrl+D 向右分屏，Ctrl+Shift+D 向下分屏。",
    "f6.name": "活动指示器", "f6.desc": "脉冲橙色 = 工作中，绿色 = 完成，红色 = 中断。",
    "f7.name": "保存会话", "f7.desc": "保存分屏布局、目录和浏览器 URL。启动时自动恢复。",
    "f8.name": "可脚本化", "f8.desc": 'CLI 和命名管道 API（<code>\\\\.\\pipe\\wmux</code>）用于自动化和脚本。兼容 cmux 的 JSON-RPC v2 协议。',
    "f9.name": "Windows 原生", "f9.desc": "ConPTY 终端模拟、Windows toast 通知、任务栏闪烁。",
    "f10.name": "GPU 加速", "f10.desc": "由 xterm.js 的 WebGL 渲染驱动，显示流畅。",
    "f11.name": "主题兼容", "f11.desc": "从 Windows Terminal 或 Ghostty 导入主题。内置 450+ Ghostty 主题。",
    "f12.name": "键盘快捷键", "f12.desc": "工作区、分屏、浏览器等完整快捷键。",
    "faq.title": "常见问题",
    "faq1.q": "wmux 和 cmux 是什么关系？", "faq1.a": 'wmux 是 <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a> 的 Windows 分支。cmux 是原生 macOS 应用。wmux 使用 Electron + xterm.js + ConPTY 在 Windows 上重现相同体验。',
    "faq2.q": "支持哪些平台？", "faq2.a": '仅 Windows 10 和 11（x64）。macOS 请使用 <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>。',
    "faq3.q": "哪些代理兼容？", "faq3.a": "wmux 针对 Claude Code 进行了优化。任何命令行代理都可使用 — Codex、Gemini CLI、Aider、OpenCode 或任何脚本。",
    "faq4.q": "通知如何工作？", "faq4.a": 'Shell 集成脚本检测命令完成或中断。支持 OSC 9/99/777、CLI <code>wmux notify</code> 和空闲检测。',
    "faq5.q": "与 Windows Terminal 有何不同？", "faq5.a": "wmux 专为监督 AI 代理而设计，具有通知系统、内置浏览器和实时元数据。",
    "faq6.q": "免费吗？", "faq6.a": '是的。wmux 是 AGPL-3.0 许可的开源项目。在 <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a> 免费下载。',
    "cta.download": "下载 Windows 版", "cta.github": "在 GitHub 上查看",
    "footer.product": "产品", "footer.changelog": "更新日志", "footer.community": "社区", "footer.releases": "发布",
    "footer.resources": "资源", "footer.docs": "文档", "footer.install": "安装", "footer.shortcuts": "快捷键",
    "footer.legal": "法律", "footer.license": "AGPL-3.0 许可证", "footer.social": "社交", "footer.copyright": "© 2026 wmux", "footer.fork": "Windows 分支自", "plugin.badge": "Claude Code 插件", "plugin.desc": "通过一条命令并行启动多个 Claude Code 代理。插件会分析代码库，将任务拆分为独立的子任务，并以波次方式分配，支持依赖管理、隔离文件区域和每轮结束时的自动审查。", "plugin.install_label": "安装", "plugin.view_github": "在 GitHub 上查看", "plugin.docs": "文档",
  },

  // ═══════════════════════════ CHINESE TRADITIONAL ═══════════════════════════
  "zh-TW": {
    "nav.docs": "文件", "nav.changelog": "更新日誌", "nav.community": "社群", "nav.github": "GitHub",
    "header.download": "下載 Windows 版",
    "hero.tagline": "專為以下場景打造的終端：", "hero.word1": "Claude Code", "hero.word2": "AI 代理", "hero.word3": "多工處理", "hero.word4": "Windows",
    "hero.desc": "基於 Electron 的 Windows 應用。垂直分頁、代理需要關注時發送通知、分割面板、內建瀏覽器和用於自動化的管道 API。",
    "hero.download": "下載 Windows 版", "hero.github": "在 GitHub 上查看",
    "features.title": "功能特性",
    "f1.name": "Claude Code 被動整合", "f1.desc": 'wmux 在不改變 Claude Code 行為的情況下進行觀察。<code>localhost:9222</code> 上的 CDP 代理讓內建瀏覽器即時顯示每個操作。',
    "f2.name": "內建瀏覽器", "f2.desc": '在終端旁開啟可腳本化的瀏覽器。當 Claude Code 透過 <code>chrome-devtools-mcp</code> 瀏覽時，一切都在瀏覽器面板中可見。',
    "f3.name": "通知環", "f3.desc": "當代理需要關注時面板會發藍光。Windows toast 通知和內建通知中心。",
    "f4.name": "垂直分頁", "f4.desc": "側邊欄顯示 git 分支、工作目錄、連接埠、代理數量、PR 狀態。",
    "f5.name": "分割面板", "f5.desc": "每個分頁中可水平和垂直分割。",
    "f6.name": "活動指示器", "f6.desc": "脈衝橘色 = 工作中，綠色 = 完成，紅色 = 中斷。",
    "f7.name": "儲存工作階段", "f7.desc": "儲存分割佈局、目錄和瀏覽器 URL。啟動時自動恢復。",
    "f8.name": "可腳本化", "f8.desc": 'CLI 和命名管道 API（<code>\\\\.\\pipe\\wmux</code>）用於自動化。',
    "f9.name": "Windows 原生", "f9.desc": "ConPTY 終端模擬、Windows toast 通知。",
    "f10.name": "GPU 加速", "f10.desc": "由 xterm.js 的 WebGL 渲染驅動。",
    "f11.name": "佈景主題相容", "f11.desc": "從 Windows Terminal 或 Ghostty 匯入佈景主題。內含 450+ Ghostty 佈景主題。",
    "f12.name": "鍵盤快速鍵", "f12.desc": "工作區、分割、瀏覽器等完整快速鍵。",
    "faq.title": "常見問題",
    "faq1.q": "wmux 和 cmux 是什麼關係？", "faq1.a": 'wmux 是 <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a> 的 Windows 分支。',
    "faq2.q": "支援哪些平台？", "faq2.a": '僅 Windows 10 和 11（x64）。macOS 請使用 <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>。',
    "faq3.q": "哪些代理相容？", "faq3.a": "wmux 針對 Claude Code 進行了最佳化。任何命令列代理皆可使用。",
    "faq4.q": "通知如何運作？", "faq4.a": 'Shell 整合腳本偵測命令完成或中斷。支援 OSC 9/99/777 和 <code>wmux notify</code>。',
    "faq5.q": "與 Windows Terminal 有何不同？", "faq5.a": "wmux 專為監督 AI 代理而設計。",
    "faq6.q": "免費嗎？", "faq6.a": '是的。wmux 是 AGPL-3.0 授權的開源專案。<a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>。',
    "cta.download": "下載 Windows 版", "cta.github": "在 GitHub 上查看",
    "footer.product": "產品", "footer.changelog": "更新日誌", "footer.community": "社群", "footer.releases": "發布",
    "footer.resources": "資源", "footer.docs": "文件", "footer.install": "安裝", "footer.shortcuts": "快速鍵",
    "footer.legal": "法律", "footer.license": "AGPL-3.0 授權", "footer.social": "社群", "footer.copyright": "© 2026 wmux", "footer.fork": "Windows 分支自", "plugin.badge": "Claude Code 外掛", "plugin.desc": "透過一條指令並行啟動多個 Claude Code 代理。外掛會分析程式碼庫，將任務拆分為獨立的子任務，並以波次方式分配，支援依賴管理、隔離檔案區域和每輪結束時的自動審查。", "plugin.install_label": "安裝", "plugin.view_github": "在 GitHub 上查看", "plugin.docs": "文件",
  },

  // ═══════════════════════════ JAPANESE ═══════════════════════════
  ja: {
    "nav.docs": "ドキュメント", "nav.changelog": "変更履歴", "nav.community": "コミュニティ", "nav.github": "GitHub",
    "header.download": "Windows版をダウンロード",
    "hero.tagline": "次のために設計されたターミナル：", "hero.word1": "Claude Code", "hero.word2": "AIエージェント", "hero.word3": "マルチタスク", "hero.word4": "Windows",
    "hero.desc": "ElectronベースのWindowsアプリケーション。垂直タブ、エージェントが注意を必要とする時の通知、分割ペイン、内蔵ブラウザ、自動化のためのパイプAPI。",
    "hero.download": "Windows版をダウンロード", "hero.github": "GitHubで見る",
    "features.title": "機能",
    "f1.name": "Claude Codeパッシブ統合", "f1.desc": 'wmuxはClaude Codeの動作を変更せずに監視します。<code>localhost:9222</code>のCDPプロキシにより、内蔵ブラウザがすべての操作をリアルタイムで表示。設定不要。',
    "f2.name": "内蔵ブラウザ", "f2.desc": 'スクリプト可能なAPIでターミナルの隣にブラウザを開きます。Claude Codeが<code>chrome-devtools-mcp</code>で閲覧すると、すべてがブラウザパネルに表示されます。',
    "f3.name": "通知リング", "f3.desc": "エージェントが注意を必要とするとパネルが青く光ります。Windowsトースト通知とタスクバーフラッシュ。",
    "f4.name": "垂直タブ", "f4.desc": "サイドバーにgitブランチ、作業ディレクトリ、ポート、エージェント数、PRステータスを表示。",
    "f5.name": "分割ペイン", "f5.desc": "各タブで水平・垂直分割。Ctrl+Dで右に分割、Ctrl+Shift+Dで下に分割。",
    "f6.name": "アクティビティインジケーター", "f6.desc": "パルスオレンジ = 作業中、緑 = 完了、赤 = 中断。",
    "f7.name": "セッション保存", "f7.desc": "分割、ディレクトリ、ブラウザURLを保存。起動時に自動復元。",
    "f8.name": "スクリプト可能", "f8.desc": 'CLIと名前付きパイプAPI（<code>\\\\.\\pipe\\wmux</code>）で自動化。cmux互換のJSON-RPC v2プロトコル。',
    "f9.name": "Windowsネイティブ", "f9.desc": "ConPTYターミナルエミュレーション、Windowsトースト通知。",
    "f10.name": "GPUアクセラレーション", "f10.desc": "xterm.jsのWebGLレンダリングによるスムーズな表示。",
    "f11.name": "テーマ互換", "f11.desc": "Windows TerminalまたはGhosttyからテーマをインポート。450以上のGhosttyテーマ同梱。",
    "f12.name": "キーボードショートカット", "f12.desc": "ワークスペース、分割、ブラウザなどの完全なショートカット。",
    "faq.title": "よくある質問",
    "faq1.q": "wmuxとcmuxの関係は？", "faq1.a": 'wmuxは<a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>のWindowsフォークです。cmuxはネイティブmacOSアプリです。',
    "faq2.q": "対応プラットフォームは？", "faq2.a": 'Windows 10と11のみ（x64）。macOSには<a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>をお使いください。',
    "faq3.q": "互換性のあるエージェントは？", "faq3.a": "wmuxはClaude Code向けに最適化。任意のコマンドラインエージェントが使用可能です。",
    "faq4.q": "通知はどう機能しますか？", "faq4.a": 'シェル統合スクリプトがコマンドの完了や中断を検出。OSC 9/99/777、<code>wmux notify</code> CLIに対応。',
    "faq5.q": "Windows Terminalとの違いは？", "faq5.a": "wmuxはAIエージェントの監視に特化しており、通知システム、内蔵ブラウザ、リアルタイムメタデータを備えています。",
    "faq6.q": "無料ですか？", "faq6.a": 'はい。wmuxはAGPL-3.0ライセンスのオープンソースです。<a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>から無料ダウンロード。',
    "cta.download": "Windows版をダウンロード", "cta.github": "GitHubで見る",
    "footer.product": "製品", "footer.changelog": "変更履歴", "footer.community": "コミュニティ", "footer.releases": "リリース",
    "footer.resources": "リソース", "footer.docs": "ドキュメント", "footer.install": "インストール", "footer.shortcuts": "ショートカット",
    "footer.legal": "法的情報", "footer.license": "AGPL-3.0ライセンス", "footer.social": "ソーシャル", "footer.copyright": "© 2026 wmux", "footer.fork": "Windowsフォーク元：", "plugin.badge": "Claude Code プラグイン", "plugin.desc": "1つのコマンドで複数のClaude Codeエージェントを並列起動。プラグインがコードベースを分析し、タスクを独立したサブタスクに分割、依存関係管理・ファイルゾーン分離・サイクル終了時の自動レビューを備えたウェーブで配分します。", "plugin.install_label": "インストール", "plugin.view_github": "GitHubで見る", "plugin.docs": "ドキュメント",
  },

  // ═══════════════════════════ KOREAN ═══════════════════════════
  ko: {
    "nav.docs": "문서", "nav.changelog": "변경 이력", "nav.community": "커뮤니티", "nav.github": "GitHub",
    "header.download": "Windows용 다운로드",
    "hero.tagline": "다음을 위해 만들어진 터미널:", "hero.word1": "Claude Code", "hero.word2": "AI 에이전트", "hero.word3": "멀티태스킹", "hero.word4": "Windows",
    "hero.desc": "Electron 기반 Windows 애플리케이션. 세로 탭, 에이전트가 주의를 필요로 할 때 알림, 분할 패널, 내장 브라우저 및 자동화를 위한 파이프 API.",
    "hero.download": "Windows용 다운로드", "hero.github": "GitHub에서 보기",
    "features.title": "기능",
    "f1.name": "Claude Code 패시브 통합", "f1.desc": 'wmux는 Claude Code의 동작을 변경하지 않고 관찰합니다. <code>localhost:9222</code>의 CDP 프록시가 내장 브라우저에서 모든 작업을 실시간으로 표시합니다.',
    "f2.name": "내장 브라우저", "f2.desc": '스크립팅 가능한 API로 터미널 옆에 브라우저를 엽니다. Claude Code가 <code>chrome-devtools-mcp</code>로 탐색하면 모든 것이 브라우저 패널에 표시됩니다.',
    "f3.name": "알림 링", "f3.desc": "에이전트가 주의를 필요로 하면 패널이 파란색으로 빛납니다. Windows 토스트 알림 및 작업 표시줄 깜빡임.",
    "f4.name": "세로 탭", "f4.desc": "사이드바에 git 브랜치, 작업 디렉토리, 포트, 에이전트 수, PR 상태를 표시합니다.",
    "f5.name": "분할 패널", "f5.desc": "각 탭에서 가로 및 세로 분할. Ctrl+D로 오른쪽 분할, Ctrl+Shift+D로 아래 분할.",
    "f6.name": "활동 표시기", "f6.desc": "맥동 주황색 = 작업 중, 녹색 = 완료, 빨간색 = 중단.",
    "f7.name": "저장된 세션", "f7.desc": "분할, 디렉토리 및 브라우저 URL을 저장합니다. 시작 시 자동 복원.",
    "f8.name": "스크립팅 가능", "f8.desc": 'CLI 및 명명된 파이프 API (<code>\\\\.\\pipe\\wmux</code>)로 자동화. cmux 호환 JSON-RPC v2 프로토콜.',
    "f9.name": "Windows 네이티브", "f9.desc": "ConPTY 터미널 에뮬레이션, Windows 토스트 알림, 작업 표시줄 깜빡임.",
    "f10.name": "GPU 가속", "f10.desc": "xterm.js의 WebGL 렌더링으로 부드러운 표시.",
    "f11.name": "테마 호환", "f11.desc": "Windows Terminal 또는 Ghostty에서 테마를 가져옵니다. 450개 이상의 Ghostty 테마 포함.",
    "f12.name": "키보드 단축키", "f12.desc": "작업 공간, 분할, 브라우저 등의 전체 단축키.",
    "faq.title": "자주 묻는 질문",
    "faq1.q": "wmux와 cmux의 관계는?", "faq1.a": 'wmux는 <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>의 Windows 포크입니다.',
    "faq2.q": "지원되는 플랫폼은?", "faq2.a": 'Windows 10 및 11만 (x64). macOS는 <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>를 사용하세요.',
    "faq3.q": "호환되는 에이전트는?", "faq3.a": "wmux는 Claude Code에 최적화되어 있습니다. 모든 명령줄 에이전트를 사용할 수 있습니다.",
    "faq4.q": "알림은 어떻게 작동하나요?", "faq4.a": '쉘 통합 스크립트가 명령 완료 또는 중단을 감지합니다. OSC 9/99/777 및 <code>wmux notify</code> 지원.',
    "faq5.q": "Windows Terminal과의 차이점은?", "faq5.a": "wmux는 알림 시스템, 내장 브라우저 및 실시간 메타데이터를 갖춘 AI 에이전트 감독용으로 설계되었습니다.",
    "faq6.q": "무료인가요?", "faq6.a": '네. wmux는 AGPL-3.0 라이선스의 오픈소스입니다. <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>에서 무료 다운로드.',
    "cta.download": "Windows용 다운로드", "cta.github": "GitHub에서 보기",
    "footer.product": "제품", "footer.changelog": "변경 이력", "footer.community": "커뮤니티", "footer.releases": "릴리스",
    "footer.resources": "리소스", "footer.docs": "문서", "footer.install": "설치", "footer.shortcuts": "단축키",
    "footer.legal": "법적 정보", "footer.license": "AGPL-3.0 라이선스", "footer.social": "소셜", "footer.copyright": "© 2026 wmux", "footer.fork": "Windows 포크 원본:", "plugin.badge": "Claude Code 플러그인", "plugin.desc": "하나의 명령으로 여러 Claude Code 에이전트를 병렬 실행합니다. 플러그인이 코드베이스를 분석하고 작업을 독립적인 하위 작업으로 분할한 뒤 의존성 관리, 격리된 파일 영역, 매 사이클 종료 시 자동 리뷰를 갖춘 웨이브로 배분합니다.", "plugin.install_label": "설치", "plugin.view_github": "GitHub에서 보기", "plugin.docs": "문서",
  },

  // ═══════════════════════════ HINDI ═══════════════════════════
  hi: {
    "nav.docs": "दस्तावेज़", "nav.changelog": "बदलाव", "nav.community": "समुदाय", "nav.github": "GitHub",
    "header.download": "Windows के लिए डाउनलोड करें",
    "hero.tagline": "इसके लिए बनाया गया टर्मिनल:", "hero.word1": "Claude Code", "hero.word2": "AI एजेंट", "hero.word3": "मल्टीटास्किंग", "hero.word4": "Windows",
    "hero.desc": "Electron पर आधारित Windows एप्लिकेशन। वर्टिकल टैब, एजेंट को ध्यान देने की आवश्यकता होने पर सूचनाएं, विभाजित पैनल, बिल्ट-इन ब्राउज़र और ऑटोमेशन के लिए पाइप API।",
    "hero.download": "Windows के लिए डाउनलोड करें", "hero.github": "GitHub पर देखें",
    "features.title": "विशेषताएं",
    "f1.name": "निष्क्रिय Claude Code एकीकरण", "f1.desc": 'wmux बिना व्यवहार बदले Claude Code को देखता है। <code>localhost:9222</code> पर CDP प्रॉक्सी हर क्रिया को रियल-टाइम में दिखाता है।',
    "f2.name": "बिल्ट-इन ब्राउज़र", "f2.desc": 'अपने टर्मिनल के साथ स्क्रिप्टेबल API वाला ब्राउज़र खोलें।',
    "f3.name": "सूचना रिंग", "f3.desc": "एजेंट को ध्यान देने की जरूरत होने पर पैनल नीले रंग में चमकते हैं।",
    "f4.name": "वर्टिकल टैब", "f4.desc": "साइडबार git ब्रांच, कार्य निर्देशिका, पोर्ट, एजेंट संख्या दिखाता है।",
    "f5.name": "विभाजित पैनल", "f5.desc": "प्रत्येक टैब में क्षैतिज और ऊर्ध्वाधर विभाजन।",
    "f6.name": "गतिविधि संकेतक", "f6.desc": "स्पंदित नारंगी = काम कर रहा है, हरा = पूर्ण, लाल = बाधित।",
    "f7.name": "सहेजे गए सत्र", "f7.desc": "अपने विभाजन, निर्देशिकाएं और ब्राउज़र URL सहेजें। स्टार्टअप पर स्वचालित पुनर्स्थापना।",
    "f8.name": "स्क्रिप्टेबल", "f8.desc": 'CLI और नामित पाइप API (<code>\\\\.\\pipe\\wmux</code>) ऑटोमेशन के लिए।',
    "f9.name": "Windows नेटिव", "f9.desc": "ConPTY टर्मिनल एमुलेशन, Windows टोस्ट सूचनाएं।",
    "f10.name": "GPU त्वरण", "f10.desc": "WebGL रेंडरिंग के साथ xterm.js द्वारा संचालित।",
    "f11.name": "थीम संगत", "f11.desc": "Windows Terminal या Ghostty से थीम आयात करें। 450+ Ghostty थीम शामिल।",
    "f12.name": "कीबोर्ड शॉर्टकट", "f12.desc": "वर्कस्पेस, विभाजन, ब्राउज़र और अधिक के लिए पूर्ण शॉर्टकट।",
    "faq.title": "अक्सर पूछे जाने वाले प्रश्न",
    "faq1.q": "wmux और cmux के बीच क्या संबंध है?", "faq1.a": 'wmux, <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a> का Windows फ़ॉर्क है।',
    "faq2.q": "कौन से प्लेटफ़ॉर्म समर्थित हैं?", "faq2.a": 'केवल Windows 10 और 11 (x64)। macOS के लिए <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a> उपयोग करें।',
    "faq3.q": "कौन से एजेंट संगत हैं?", "faq3.a": "wmux Claude Code के लिए अनुकूलित है। कोई भी कमांड-लाइन एजेंट उपयोग किया जा सकता है।",
    "faq4.q": "सूचनाएं कैसे काम करती हैं?", "faq4.a": 'शेल एकीकरण स्क्रिप्ट कमांड पूर्ण होने या बाधित होने का पता लगाती हैं। OSC 9/99/777 और <code>wmux notify</code> समर्थित।',
    "faq5.q": "Windows Terminal से कैसे अलग है?", "faq5.a": "wmux विशेष रूप से AI एजेंटों की निगरानी के लिए डिज़ाइन किया गया है।",
    "faq6.q": "क्या यह मुफ्त है?", "faq6.a": 'हाँ। wmux AGPL-3.0 लाइसेंस के तहत ओपन-सोर्स है। <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a> से मुफ्त डाउनलोड करें।',
    "cta.download": "Windows के लिए डाउनलोड करें", "cta.github": "GitHub पर देखें",
    "footer.product": "उत्पाद", "footer.changelog": "बदलाव", "footer.community": "समुदाय", "footer.releases": "रिलीज़",
    "footer.resources": "संसाधन", "footer.docs": "दस्तावेज़ीकरण", "footer.install": "स्थापना", "footer.shortcuts": "शॉर्टकट",
    "footer.legal": "कानूनी", "footer.license": "AGPL-3.0 लाइसेंस", "footer.social": "सोशल", "footer.copyright": "© 2026 wmux", "footer.fork": "Windows फ़ॉर्क:", "plugin.badge": "Claude Code प्लगइन", "plugin.desc": "एक ही कमांड से कई Claude Code एजेंट समानांतर में लॉन्च करें। प्लगइन आपके कोडबेस का विश्लेषण करता है, कार्य को स्वतंत्र उप-कार्यों में विभाजित करता है और उन्हें निर्भरता प्रबंधन, पृथक फ़ाइल ज़ोन और प्रत्येक चक्र के अंत में स्वचालित समीक्षा के साथ तरंगों में वितरित करता है।", "plugin.install_label": "इंस्टॉल", "plugin.view_github": "GitHub पर देखें", "plugin.docs": "प्रलेखन",
  },

  // ═══════════════════════════ VIETNAMESE ═══════════════════════════
  vi: {
    "nav.docs": "Tài liệu", "nav.changelog": "Nhật ký thay đổi", "nav.community": "Cộng đồng", "nav.github": "GitHub",
    "header.download": "Tải cho Windows",
    "hero.tagline": "Terminal được thiết kế cho", "hero.word1": "Claude Code", "hero.word2": "AI agents", "hero.word3": "đa nhiệm", "hero.word4": "Windows",
    "hero.desc": "Ứng dụng Windows dựa trên Electron. Tab dọc, thông báo khi agent cần chú ý, bảng chia, trình duyệt tích hợp và API pipe để tự động hóa.",
    "hero.download": "Tải cho Windows", "hero.github": "Xem trên GitHub",
    "features.title": "Tính năng",
    "f1.name": "Tích hợp thụ động Claude Code", "f1.desc": 'wmux quan sát Claude Code mà không thay đổi hành vi. CDP proxy trên <code>localhost:9222</code> cho trình duyệt tích hợp hiển thị mọi hành động theo thời gian thực.',
    "f2.name": "Trình duyệt tích hợp", "f2.desc": 'mở trình duyệt bên cạnh terminal với API có thể lập trình.',
    "f3.name": "Vòng thông báo", "f3.desc": "bảng phát sáng xanh khi agent cần chú ý. Thông báo toast Windows.",
    "f4.name": "Tab dọc", "f4.desc": "thanh bên hiển thị nhánh git, thư mục làm việc, cổng, số agent, trạng thái PR.",
    "f5.name": "Bảng chia", "f5.desc": "chia ngang và dọc trong mỗi tab.",
    "f6.name": "Chỉ báo hoạt động", "f6.desc": "cam nhấp nháy = đang làm, xanh = xong, đỏ = bị gián đoạn.",
    "f7.name": "Phiên đã lưu", "f7.desc": "lưu bố cục chia, thư mục và URL trình duyệt. Tự động khôi phục khi khởi động.",
    "f8.name": "Có thể lập trình", "f8.desc": 'CLI và API named pipe (<code>\\\\.\\pipe\\wmux</code>) để tự động hóa.',
    "f9.name": "Windows gốc", "f9.desc": "ConPTY, thông báo toast Windows, nhấp nháy thanh tác vụ.",
    "f10.name": "Tăng tốc GPU", "f10.desc": "được cung cấp bởi xterm.js với WebGL rendering.",
    "f11.name": "Tương thích chủ đề", "f11.desc": "nhập chủ đề từ Windows Terminal hoặc Ghostty. 450+ chủ đề Ghostty đi kèm.",
    "f12.name": "Phím tắt", "f12.desc": "phím tắt đầy đủ cho workspace, chia, trình duyệt và hơn thế nữa.",
    "faq.title": "Câu hỏi thường gặp",
    "faq1.q": "Mối quan hệ giữa wmux và cmux?", "faq1.a": 'wmux là fork Windows của <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>.',
    "faq2.q": "Hỗ trợ nền tảng nào?", "faq2.a": 'Chỉ Windows 10 và 11 (x64). Cho macOS dùng <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>.',
    "faq3.q": "Agent nào tương thích?", "faq3.a": "wmux được tối ưu cho Claude Code. Bất kỳ agent dòng lệnh nào đều có thể sử dụng.",
    "faq4.q": "Thông báo hoạt động như thế nào?", "faq4.a": 'Script tích hợp shell phát hiện lệnh hoàn thành hoặc bị gián đoạn. Hỗ trợ OSC 9/99/777 và <code>wmux notify</code>.',
    "faq5.q": "Khác gì với Windows Terminal?", "faq5.a": "wmux được thiết kế đặc biệt để giám sát AI agent.",
    "faq6.q": "Miễn phí không?", "faq6.a": 'Có. wmux là mã nguồn mở theo giấy phép AGPL-3.0. <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Tải cho Windows", "cta.github": "Xem trên GitHub",
    "footer.product": "Sản phẩm", "footer.changelog": "Nhật ký", "footer.community": "Cộng đồng", "footer.releases": "Phát hành",
    "footer.resources": "Tài nguyên", "footer.docs": "Tài liệu", "footer.install": "Cài đặt", "footer.shortcuts": "Phím tắt",
    "footer.legal": "Pháp lý", "footer.license": "Giấy phép AGPL-3.0", "footer.social": "Mạng xã hội", "footer.copyright": "© 2026 wmux", "footer.fork": "Fork Windows của", "plugin.badge": "Plugin Claude Code", "plugin.desc": "Chạy nhiều agent Claude Code song song chỉ với một lệnh. Plugin phân tích mã nguồn, chia tác vụ thành các tác vụ con độc lập và phân phối chúng theo đợt với quản lý phụ thuộc, vùng tệp cô lập và đánh giá tự động cuối mỗi chu kỳ.", "plugin.install_label": "Cài đặt", "plugin.view_github": "Xem trên GitHub", "plugin.docs": "Tài liệu",
  },

  // ═══════════════════════════ THAI ═══════════════════════════
  th: {
    "nav.docs": "เอกสาร", "nav.changelog": "บันทึกการเปลี่ยนแปลง", "nav.community": "ชุมชน", "nav.github": "GitHub",
    "header.download": "ดาวน์โหลดสำหรับ Windows",
    "hero.tagline": "เทอร์มินัลที่สร้างสำหรับ", "hero.word1": "Claude Code", "hero.word2": "AI agents", "hero.word3": "มัลติทาสกิ้ง", "hero.word4": "Windows",
    "hero.desc": "แอปพลิเคชัน Windows บน Electron แท็บแนวตั้ง การแจ้งเตือนเมื่อ agent ต้องการความสนใจ แผงแบ่ง เบราว์เซอร์ในตัว และ API ท่อสำหรับอัตโนมัติ",
    "hero.download": "ดาวน์โหลดสำหรับ Windows", "hero.github": "ดูบน GitHub",
    "features.title": "คุณสมบัติ",
    "f1.name": "การรวม Claude Code แบบพาสซีฟ", "f1.desc": 'wmux สังเกต Claude Code โดยไม่เปลี่ยนแปลงพฤติกรรม CDP proxy บน <code>localhost:9222</code> แสดงทุกการกระทำแบบเรียลไทม์',
    "f2.name": "เบราว์เซอร์ในตัว", "f2.desc": "เปิดเบราว์เซอร์ข้างเทอร์มินัลพร้อม API ที่เขียนสคริปต์ได้",
    "f3.name": "วงแหวนแจ้งเตือน", "f3.desc": "แผงเรืองแสงสีน้ำเงินเมื่อ agent ต้องการความสนใจ",
    "f4.name": "แท็บแนวตั้ง", "f4.desc": "แถบด้านข้างแสดง git branch ไดเรกทอรีทำงาน พอร์ต จำนวน agent",
    "f5.name": "แผงแบ่ง", "f5.desc": "แบ่งแนวนอนและแนวตั้งในแต่ละแท็บ",
    "f6.name": "ตัวบ่งชี้กิจกรรม", "f6.desc": "ส้มกระพริบ = ทำงาน เขียว = เสร็จ แดง = ถูกขัดจังหวะ",
    "f7.name": "เซสชันที่บันทึก", "f7.desc": "บันทึกการแบ่ง ไดเรกทอรี และ URL เบราว์เซอร์ กู้คืนอัตโนมัติเมื่อเริ่มต้น",
    "f8.name": "เขียนสคริปต์ได้", "f8.desc": 'CLI และ API named pipe (<code>\\\\.\\pipe\\wmux</code>) สำหรับอัตโนมัติ',
    "f9.name": "Windows เนทีฟ", "f9.desc": "ConPTY การแจ้งเตือน toast ของ Windows",
    "f10.name": "GPU acceleration", "f10.desc": "ขับเคลื่อนโดย xterm.js พร้อม WebGL rendering",
    "f11.name": "ธีมที่เข้ากันได้", "f11.desc": "นำเข้าธีมจาก Windows Terminal หรือ Ghostty 450+ ธีม Ghostty รวมอยู่",
    "f12.name": "ปุ่มลัด", "f12.desc": "ปุ่มลัดครบถ้วนสำหรับเวิร์กสเปซ การแบ่ง เบราว์เซอร์และอื่นๆ",
    "faq.title": "คำถามที่พบบ่อย",
    "faq1.q": "wmux และ cmux เกี่ยวข้องกันอย่างไร?", "faq1.a": 'wmux เป็น fork Windows ของ <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>',
    "faq2.q": "รองรับแพลตฟอร์มใดบ้าง?", "faq2.a": 'Windows 10 และ 11 เท่านั้น (x64) สำหรับ macOS ใช้ <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>',
    "faq3.q": "agent ใดที่เข้ากันได้?", "faq3.a": "wmux ปรับให้เหมาะสมสำหรับ Claude Code agent บรรทัดคำสั่งใดก็ได้สามารถใช้ได้",
    "faq4.q": "การแจ้งเตือนทำงานอย่างไร?", "faq4.a": 'สคริปต์รวม shell ตรวจจับเมื่อคำสั่งเสร็จสิ้นหรือถูกขัดจังหวะ รองรับ OSC 9/99/777 และ <code>wmux notify</code>',
    "faq5.q": "แตกต่างจาก Windows Terminal อย่างไร?", "faq5.a": "wmux ออกแบบมาเพื่อดูแล AI agent โดยเฉพาะ",
    "faq6.q": "ฟรีหรือไม่?", "faq6.a": 'ใช่ wmux เป็นโอเพนซอร์สภายใต้ AGPL-3.0 <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>',
    "cta.download": "ดาวน์โหลดสำหรับ Windows", "cta.github": "ดูบน GitHub",
    "footer.product": "ผลิตภัณฑ์", "footer.changelog": "บันทึก", "footer.community": "ชุมชน", "footer.releases": "รุ่น",
    "footer.resources": "ทรัพยากร", "footer.docs": "เอกสาร", "footer.install": "การติดตั้ง", "footer.shortcuts": "ปุ่มลัด",
    "footer.legal": "กฎหมาย", "footer.license": "สัญญาอนุญาต AGPL-3.0", "footer.social": "โซเชียล", "footer.copyright": "© 2026 wmux", "footer.fork": "Fork Windows ของ", "plugin.badge": "ปลั๊กอิน Claude Code", "plugin.desc": "เรียกใช้ตัวแทน Claude Code หลายตัวพร้อมกันด้วยคำสั่งเดียว ปลั๊กอินวิเคราะห์โค้ดเบส แบ่งงานเป็นงานย่อยอิสระ และกระจายเป็นคลื่นพร้อมจัดการการพึ่งพา โซนไฟล์แยก และตรวจสอบอัตโนมัติเมื่อสิ้นสุดรอบ", "plugin.install_label": "ติดตั้ง", "plugin.view_github": "ดูบน GitHub", "plugin.docs": "เอกสาร",
  },

  // ═══════════════════════════ INDONESIAN ═══════════════════════════
  id: {
    "nav.docs": "Dokumentasi", "nav.changelog": "Perubahan", "nav.community": "Komunitas", "nav.github": "GitHub",
    "header.download": "Unduh untuk Windows",
    "hero.tagline": "Terminal yang dibuat untuk", "hero.word1": "Claude Code", "hero.word2": "agen AI", "hero.word3": "multitasking", "hero.word4": "Windows",
    "hero.desc": "Aplikasi Windows berbasis Electron. Tab vertikal, notifikasi saat agen butuh perhatian, panel terbagi, browser bawaan dan API pipe untuk otomatisasi.",
    "hero.download": "Unduh untuk Windows", "hero.github": "Lihat di GitHub",
    "features.title": "Fitur",
    "f1.name": "Integrasi pasif Claude Code", "f1.desc": 'wmux mengamati Claude Code tanpa mengubah perilakunya. CDP proxy di <code>localhost:9222</code> menampilkan setiap aksi secara real-time.',
    "f2.name": "Browser bawaan", "f2.desc": "buka browser di samping terminal dengan API yang dapat diprogram.",
    "f3.name": "Cincin notifikasi", "f3.desc": "panel bersinar biru saat agen butuh perhatian. Notifikasi toast Windows.",
    "f4.name": "Tab vertikal", "f4.desc": "sidebar menampilkan branch git, direktori kerja, port, jumlah agen, status PR.",
    "f5.name": "Panel terbagi", "f5.desc": "pembagian horizontal dan vertikal di setiap tab.",
    "f6.name": "Indikator aktivitas", "f6.desc": "oranye berkedip = bekerja, hijau = selesai, merah = terganggu.",
    "f7.name": "Sesi tersimpan", "f7.desc": "simpan pembagian, direktori dan URL browser. Pemulihan otomatis saat startup.",
    "f8.name": "Dapat diprogram", "f8.desc": 'CLI dan API named pipe (<code>\\\\.\\pipe\\wmux</code>) untuk otomatisasi.',
    "f9.name": "Windows native", "f9.desc": "ConPTY, notifikasi toast Windows, kedipan taskbar.",
    "f10.name": "Akselerasi GPU", "f10.desc": "didukung xterm.js dengan rendering WebGL.",
    "f11.name": "Kompatibel tema", "f11.desc": "impor tema dari Windows Terminal atau Ghostty. 450+ tema Ghostty disertakan.",
    "f12.name": "Pintasan keyboard", "f12.desc": "pintasan lengkap untuk workspace, pembagian, browser dan lainnya.",
    "faq.title": "Pertanyaan yang sering diajukan",
    "faq1.q": "Apa hubungan wmux dan cmux?", "faq1.a": 'wmux adalah fork Windows dari <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>.',
    "faq2.q": "Platform apa yang didukung?", "faq2.a": 'Hanya Windows 10 dan 11 (x64). Untuk macOS gunakan <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>.',
    "faq3.q": "Agen apa yang kompatibel?", "faq3.a": "wmux dioptimalkan untuk Claude Code. Agen baris perintah apa pun bisa digunakan.",
    "faq4.q": "Bagaimana notifikasi bekerja?", "faq4.a": 'Skrip integrasi shell mendeteksi perintah selesai atau terganggu. Mendukung OSC 9/99/777 dan <code>wmux notify</code>.',
    "faq5.q": "Apa bedanya dengan Windows Terminal?", "faq5.a": "wmux dirancang khusus untuk mengawasi agen AI.",
    "faq6.q": "Gratis?", "faq6.a": 'Ya. wmux adalah open-source di bawah lisensi AGPL-3.0. <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Unduh untuk Windows", "cta.github": "Lihat di GitHub",
    "footer.product": "Produk", "footer.changelog": "Perubahan", "footer.community": "Komunitas", "footer.releases": "Rilis",
    "footer.resources": "Sumber daya", "footer.docs": "Dokumentasi", "footer.install": "Instalasi", "footer.shortcuts": "Pintasan",
    "footer.legal": "Hukum", "footer.license": "Lisensi AGPL-3.0", "footer.social": "Sosial", "footer.copyright": "© 2026 wmux", "footer.fork": "Fork Windows dari", "plugin.badge": "Plugin Claude Code", "plugin.desc": "Jalankan beberapa agen Claude Code secara paralel dengan satu perintah. Plugin menganalisis basis kode, membagi tugas menjadi sub-tugas independen, dan mendistribusikannya dalam gelombang dengan manajemen dependensi, zona file terisolasi, dan tinjauan otomatis di akhir setiap siklus.", "plugin.install_label": "Instalasi", "plugin.view_github": "Lihat di GitHub", "plugin.docs": "Dokumentasi",
  },

  // ═══════════════════════════ SWEDISH ═══════════════════════════
  sv: {
    "nav.docs": "Docs", "nav.changelog": "Ändringar", "nav.community": "Community", "nav.github": "GitHub",
    "header.download": "Ladda ner för Windows",
    "hero.tagline": "Terminalen byggd för", "hero.word1": "Claude Code", "hero.word2": "AI-agenter", "hero.word3": "multitasking", "hero.word4": "Windows",
    "hero.desc": "Windows-applikation byggd på Electron. Vertikala flikar, aviseringar när agenter behöver uppmärksamhet, delade paneler, inbyggd webbläsare och ett pipe-API för automatisering.",
    "hero.download": "Ladda ner för Windows", "hero.github": "Visa på GitHub",
    "features.title": "Funktioner",
    "f1.name": "Passiv Claude Code-integration", "f1.desc": 'wmux observerar Claude Code utan att ändra dess beteende. En CDP-proxy på <code>localhost:9222</code> visar varje åtgärd i realtid.',
    "f2.name": "Inbyggd webbläsare", "f2.desc": "öppna en webbläsare bredvid din terminal med ett skriptbart API.",
    "f3.name": "Aviseringsringar", "f3.desc": "paneler lyser blått när agenter behöver uppmärksamhet. Windows toast-aviseringar.",
    "f4.name": "Vertikala flikar", "f4.desc": "sidofältet visar git-gren, arbetskatalog, portar, antal agenter, PR-status.",
    "f5.name": "Delade paneler", "f5.desc": "horisontella och vertikala delningar i varje flik.",
    "f6.name": "Aktivitetsindikatorer", "f6.desc": "pulserande orange = arbetar, grönt = klart, rött = avbrutet.",
    "f7.name": "Sparade sessioner", "f7.desc": "spara dina delningar, kataloger och webbläsar-URL. Automatisk återställning vid start.",
    "f8.name": "Skriptbar", "f8.desc": 'CLI och named pipe API (<code>\\\\.\\pipe\\wmux</code>) för automatisering.',
    "f9.name": "Windows-nativ", "f9.desc": "ConPTY, Windows toast-aviseringar, aktivitetsfältsblink.",
    "f10.name": "GPU-acceleration", "f10.desc": "drivs av xterm.js med WebGL-rendering.",
    "f11.name": "Temakompatibel", "f11.desc": "importera teman från Windows Terminal eller Ghostty. 450+ Ghostty-teman inkluderade.",
    "f12.name": "Tangentbordsgenvägar", "f12.desc": "fullständiga genvägar för arbetsytor, delningar, webbläsare och mer.",
    "faq.title": "Vanliga frågor",
    "faq1.q": "Vad är förhållandet mellan wmux och cmux?", "faq1.a": 'wmux är en Windows-fork av <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>.',
    "faq2.q": "Vilka plattformar stöds?", "faq2.a": 'Bara Windows 10 och 11 (x64). För macOS använd <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>.',
    "faq3.q": "Vilka agenter är kompatibla?", "faq3.a": "wmux är optimerad för Claude Code. Alla kommandoradsagenter kan användas.",
    "faq4.q": "Hur fungerar aviseringarna?", "faq4.a": 'Shell-integrationsskript upptäcker när ett kommando avslutas eller avbryts. Stöder OSC 9/99/777 och <code>wmux notify</code>.',
    "faq5.q": "Hur skiljer det sig från Windows Terminal?", "faq5.a": "wmux är specifikt designad för att övervaka AI-agenter.",
    "faq6.q": "Är det gratis?", "faq6.a": 'Ja. wmux är öppen källkod under AGPL-3.0. <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Ladda ner för Windows", "cta.github": "Visa på GitHub",
    "footer.product": "Produkt", "footer.changelog": "Ändringar", "footer.community": "Community", "footer.releases": "Utgåvor",
    "footer.resources": "Resurser", "footer.docs": "Dokumentation", "footer.install": "Installation", "footer.shortcuts": "Genvägar",
    "footer.legal": "Juridiskt", "footer.license": "AGPL-3.0-licens", "footer.social": "Socialt", "footer.copyright": "© 2026 wmux", "footer.fork": "Windows-fork av", "plugin.badge": "Claude Code-plugin", "plugin.desc": "Starta flera Claude Code-agenter parallellt med ett enda kommando. Pluginet analyserar din kodbas, delar upp uppgiften i oberoende deluppgifter och fördelar dem i vågor med beroendehantering, isolerade filzoner och automatisk granskning i slutet av varje cykel.", "plugin.install_label": "Installation", "plugin.view_github": "Visa på GitHub", "plugin.docs": "Dokumentation",
  },

  // ═══════════════════════════ CZECH ═══════════════════════════
  cs: {
    "nav.docs": "Dokumentace", "nav.changelog": "Změny", "nav.community": "Komunita", "nav.github": "GitHub",
    "header.download": "Stáhnout pro Windows",
    "hero.tagline": "Terminál navržený pro", "hero.word1": "Claude Code", "hero.word2": "AI agenty", "hero.word3": "multitasking", "hero.word4": "Windows",
    "hero.desc": "Windows aplikace postavená na Electronu. Vertikální karty, upozornění když agenti potřebují pozornost, rozdělené panely, vestavěný prohlížeč a pipe API pro automatizaci.",
    "hero.download": "Stáhnout pro Windows", "hero.github": "Zobrazit na GitHubu",
    "features.title": "Funkce",
    "f1.name": "Pasivní integrace Claude Code", "f1.desc": 'wmux pozoruje Claude Code bez změny jeho chování. CDP proxy na <code>localhost:9222</code> zobrazuje každou akci v reálném čase.',
    "f2.name": "Vestavěný prohlížeč", "f2.desc": "otevřete prohlížeč vedle terminálu se skriptovatelným API.",
    "f3.name": "Oznamovací kroužky", "f3.desc": "panely svítí modře když agenti potřebují pozornost. Windows toast upozornění.",
    "f4.name": "Vertikální karty", "f4.desc": "boční panel zobrazuje git větev, pracovní adresář, porty, počet agentů, stav PR.",
    "f5.name": "Rozdělené panely", "f5.desc": "horizontální a vertikální rozdělení v každé kartě.",
    "f6.name": "Ukazatele aktivity", "f6.desc": "pulzující oranžová = pracuje, zelená = hotovo, červená = přerušeno.",
    "f7.name": "Uložené relace", "f7.desc": "uložte rozdělení, adresáře a URL prohlížeče. Automatické obnovení při spuštění.",
    "f8.name": "Skriptovatelný", "f8.desc": 'CLI a named pipe API (<code>\\\\.\\pipe\\wmux</code>) pro automatizaci.',
    "f9.name": "Windows nativní", "f9.desc": "ConPTY, Windows toast upozornění, blikání hlavního panelu.",
    "f10.name": "GPU akcelerace", "f10.desc": "poháněno xterm.js s WebGL renderováním.",
    "f11.name": "Kompatibilní témata", "f11.desc": "importujte témata z Windows Terminal nebo Ghostty. 450+ Ghostty témat v balení.",
    "f12.name": "Klávesové zkratky", "f12.desc": "kompletní zkratky pro pracovní prostory, rozdělení, prohlížeč a další.",
    "faq.title": "Často kladené otázky",
    "faq1.q": "Jaký je vztah mezi wmux a cmux?", "faq1.a": 'wmux je Windows fork projektu <a href="https://github.com/manaflow-ai/cmux" target="_blank" rel="noopener">cmux</a>.',
    "faq2.q": "Jaké platformy jsou podporovány?", "faq2.a": 'Pouze Windows 10 a 11 (x64). Pro macOS použijte <a href="https://cmux.com" target="_blank" rel="noopener">cmux</a>.',
    "faq3.q": "Kteří agenti jsou kompatibilní?", "faq3.a": "wmux je optimalizován pro Claude Code. Jakýkoli agent příkazové řádky může být použit.",
    "faq4.q": "Jak fungují upozornění?", "faq4.a": 'Skripty integrace shellu detekují dokončení nebo přerušení příkazu. Podporuje OSC 9/99/777 a <code>wmux notify</code>.',
    "faq5.q": "Čím se liší od Windows Terminal?", "faq5.a": "wmux je navržen speciálně pro dohled nad AI agenty.",
    "faq6.q": "Je to zdarma?", "faq6.a": 'Ano. wmux je open-source pod licencí AGPL-3.0. <a href="https://github.com/amirlehmam/wmux/releases" target="_blank" rel="noopener">GitHub Releases</a>.',
    "cta.download": "Stáhnout pro Windows", "cta.github": "Zobrazit na GitHubu",
    "footer.product": "Produkt", "footer.changelog": "Změny", "footer.community": "Komunita", "footer.releases": "Vydání",
    "footer.resources": "Zdroje", "footer.docs": "Dokumentace", "footer.install": "Instalace", "footer.shortcuts": "Zkratky",
    "footer.legal": "Právní", "footer.license": "Licence AGPL-3.0", "footer.social": "Sociální sítě", "footer.copyright": "© 2026 wmux", "footer.fork": "Windows fork projektu", "plugin.badge": "Plugin Claude Code", "plugin.desc": "Spusťte více agentů Claude Code paralelně jedním příkazem. Plugin analyzuje kódovou základnu, rozdělí úkol na nezávislé podúkoly a distribuuje je ve vlnách se správou závislostí, izolovanými souborovými zónami a automatickou kontrolou na konci každého cyklu.", "plugin.install_label": "Instalace", "plugin.view_github": "Zobrazit na GitHubu", "plugin.docs": "Dokumentace",
  },
};

// ═══════════════════════════ ENGINE ═══════════════════════════

function detectLang() {
  // 1. URL hash (#fr, #ar, etc.)
  const hash = location.hash.replace("#", "").toLowerCase();
  if (hash && T[hash]) return hash;
  // Also try zh-TW style
  if (hash === "zh-tw" && T["zh-TW"]) return "zh-TW";

  // 2. localStorage preference
  const saved = localStorage.getItem("wmux-lang");
  if (saved && T[saved]) return saved;

  // 3. Browser language
  const nav = navigator.language || navigator.userLanguage || "en";
  // Try exact match first (e.g., zh-TW)
  if (T[nav]) return nav;
  // Try base language (e.g., "fr-FR" → "fr")
  const base = nav.split("-")[0].toLowerCase();
  if (T[base]) return base;
  // Special: zh-Hans → zh, zh-Hant → zh-TW
  if (base === "zh") {
    if (nav.includes("Hant") || nav.includes("TW") || nav.includes("HK")) return "zh-TW";
    return "zh";
  }

  return "en";
}

function applyLang(lang) {
  const strings = T[lang];
  if (!strings) return;

  // Set direction
  const isRTL = RTL_LANGS.includes(lang);
  document.documentElement.dir = isRTL ? "rtl" : "ltr";
  document.documentElement.lang = lang;

  // Update all data-i18n elements
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (strings[key] != null) {
      el.textContent = strings[key];
    }
  });

  // Update all data-i18n-html elements (contain HTML like <code>, <a>)
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html");
    if (strings[key] != null) {
      el.innerHTML = strings[key];
    }
  });

  // Update page title
  document.title = `wmux — ${strings["hero.tagline"]} Claude Code`;

  // Update language selector display
  const sel = document.getElementById("lang-current");
  if (sel) sel.textContent = LANGS[lang] || lang;

  // Save preference
  localStorage.setItem("wmux-lang", lang);

  // Update hash without scrolling
  history.replaceState(null, "", `#${lang}`);
}

function buildLangSelector() {
  const container = document.getElementById("lang-selector");
  if (!container) return;

  const dropdown = document.createElement("div");
  dropdown.className = "lang-dropdown";

  Object.entries(LANGS).forEach(([code, name]) => {
    const btn = document.createElement("button");
    btn.textContent = name;
    btn.className = "lang-option";
    btn.setAttribute("data-lang", code);
    btn.addEventListener("click", () => {
      applyLang(code);
      dropdown.classList.remove("open");
    });
    dropdown.appendChild(btn);
  });

  container.appendChild(dropdown);

  const trigger = container.querySelector(".lang-trigger");
  if (trigger) {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("open");
    });
  }

  // Close on outside click
  document.addEventListener("click", () => dropdown.classList.remove("open"));
}

// Init — script is at bottom of <body>, DOM is already parsed
function init() {
  buildLangSelector();
  const lang = detectLang();
  applyLang(lang);
}

// Use requestAnimationFrame to ensure paint has happened and DOM is fully wired
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(init));
} else {
  requestAnimationFrame(init);
}

// Also handle hash changes without page reload
window.addEventListener("hashchange", () => {
  const hash = location.hash.replace("#", "").toLowerCase();
  const lang = hash === "zh-tw" ? "zh-TW" : hash;
  if (T[lang]) applyLang(lang);
});
