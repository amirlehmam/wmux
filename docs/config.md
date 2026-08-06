# wmux config file

wmux reads `~/.wmux/config.toml` on startup (Windows: `%USERPROFILE%\.wmux\config.toml`).
The file is optional — if it isn't present, built-in defaults apply.

Edit it, then run `wmux reload-config` (or restart wmux) to pick up changes.

## Full example

```toml
[terminal]
font-family      = "Cascadia Mono"
font-size        = 14
cursor-style     = "block"        # block | underline | bar
cursor-blink     = true
scrollback-lines = 10000

[terminal.colors]
# Default scheme for every new pane. Any bundled theme name works
# (see `wmux list-themes`), or the key of a user-defined scheme below.
default = "Dracula"

# User-defined named schemes — override individual fields of the base theme.
# Invoke them with:   wmux split --color-scheme prod
[terminal.colors.schemes.prod]
background = "#2b0b0b"
foreground = "#ffdddd"
cursor     = "#ff5555"

[terminal.colors.schemes.staging]
background = "#2b1f0b"
foreground = "#ffeecc"
cursor     = "#ffaa44"

[terminal.colors.schemes.dev]
background = "#0b1f0b"
foreground = "#ccffcc"
cursor     = "#55ff55"

# Full palette override (up to 16 ANSI colors) — optional.
[terminal.colors.schemes.mono]
background = "#000000"
foreground = "#ffffff"
palette = [
  "#000000", "#ff0000", "#00ff00", "#ffff00",
  "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  "#555555", "#ff5555", "#55ff55", "#ffff55",
  "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
]

[keys]
# Remap what a key sends to the terminal (see "Key remaps" below).
"ctrl+k"       = "<C-k><Delete>"   # kill to end of line, then pull the next line up
"ctrl+alt+r"   = "clear<CR>"
"ctrl+shift+q" = ""                # empty value = swallow the key
```

## Key remaps

`[keys]` maps a key chord to the bytes wmux should send to the program running in
the terminal. Each entry is `"chord" = "sequence"`.

```toml
[keys]
"ctrl+k" = "<C-k><Delete>"
```

**Chords** are written `ctrl+shift+alt+key` (any subset, any order), or in the
vim style `<C-k>` / `<C-S-Tab>`. `alt` and `meta` both mean Alt.

**Sequences** are sent as typed, with `<...>` naming a key:

| Token | Sends | Token | Sends |
|---|---|---|---|
| `<CR>` / `<Enter>` | Enter | `<Up>` `<Down>` `<Left>` `<Right>` | arrow keys |
| `<Esc>` | Escape | `<Home>` `<End>` | Home / End |
| `<Tab>` / `<S-Tab>` | Tab / Shift+Tab | `<PgUp>` `<PgDn>` | Page Up / Down |
| `<BS>` | Backspace | `<Ins>` | Insert |
| `<Delete>` / `<Del>` | Delete | `<F1>`…`<F12>` | function keys |
| `<C-x>` | Ctrl+x control byte | `<Space>` | space |
| `<A-x>` / `<M-x>` | Alt+x (ESC prefix) | `<lt>` | a literal `<` |

Anything outside `<...>` is sent literally, so `"clear<CR>"` types the word and
presses Enter. An empty value (`""`) swallows the key.

Notes:

- Remaps apply **inside terminal panes only**, and they take priority over
  wmux's own shortcuts there — remapping `ctrl+t` means Ctrl+T no longer opens a
  tab while a terminal has focus.
- Modifiers match exactly: a `ctrl+k` remap does not fire on Ctrl+Shift+K.
- A binding that doesn't parse is reported by `wmux config show` and skipped;
  the rest of your bindings still apply.
- `wmux reload-config` applies edits live, including removing bindings.

## UI translations

wmux ships English, Español, Français, Italiano, 한국어 and 中文. You can add a
language, or correct a shipped one, without waiting for a release: drop a JSON
file into `~/.wmux/locales/`, next to `config.toml`.

```
~/.wmux/locales/
  de.json      # adds Deutsch to Settings → General → Interface language
  ko.json      # overrides individual bundled Korean strings
```

The filename is the language code. The file is a key → string map, optionally
wrapped in `strings` with a `label` for the dropdown:

```json
{
  "label": "Deutsch",
  "strings": {
    "settings.title": "Einstellungen",
    "markdown.copy": "Kopieren"
  }
}
```

A flat map without `label`/`strings` works too, in which case the code is used
as the dropdown name.

**How it merges.** A file whose code matches a bundled language overrides only
the keys it lists — you can fix one string without restating the rest. A file
with a new code adds a language, falling back to English for anything it does
not translate. Removing the file and reloading undoes it; the file is the whole
state.

The full key list is the English dictionary, which is the source of truth:
[`src/renderer/i18n/locales/en.ts`](../src/renderer/i18n/locales/en.ts).
Placeholders like `{count}` and `{name}` must survive verbatim — they are
substituted by the UI, so a renamed or dropped token silently breaks the string.

```bash
wmux locales          # what loaded, and why any file was rejected
wmux locales path     # print ~/.wmux/locales
wmux locales reload    # re-read and apply live (same as `wmux reload-config`)
```

Notes and limits:

- Codes must be **base tags** (`de`, not `de-AT`). Language auto-detection
  collapses the OS locale to its base tag, so a region-subtagged file would
  define a language that could never be selected automatically.
- Keys that are not in the English dictionary are ignored, and `wmux locales`
  reports how many — that is usually a typo or a key removed by a later release.
- A malformed file costs you that file only; the rest of the directory and every
  bundled language still load.
- Once you select a user-defined language it survives restarts. If you later
  delete the file, wmux falls back to your OS language rather than showing raw
  keys.
- Translations are welcome upstream too — a PR adding
  `src/renderer/i18n/locales/xx.ts` makes it a bundled language for everyone.

## Precedence

1. Built-in defaults
2. Settings UI values (persisted to Zustand / localStorage)
3. **`config.toml`** — applied over 1 and 2 at startup and on `reload-config`
4. Per-pane overrides (e.g. `wmux split --color-scheme prod`) — always win for that pane

"File wins at startup, app wins at runtime": if you tweak a value in the Settings
UI after wmux booted, your tweak sticks until the next reload.

## CLI helpers

```bash
wmux config path      # print the config file path
wmux config show      # dump the parsed config (useful for debugging syntax)
wmux config reload    # re-read the file and apply to running surfaces
wmux reload-config    # alias of `config reload`
wmux list-themes      # print all valid `default`/`--color-scheme` names
wmux locales          # list community translations and any load errors
```

## Notes

- Keys can be written either `kebab-case` or `camelCase`
  (`font-family` and `fontFamily` both work).
- `cursor` inside a scheme is the cursor color; use `cursor-style` (under `[terminal]`)
  for the shape.
- A parse error in one key is reported in `wmux config show` but never
  aborts loading — the rest of the file still applies.
- Per-pane overrides via `wmux split --color-scheme NAME` or
  `wmux set-color-scheme [id] NAME` always take precedence for that surface.
