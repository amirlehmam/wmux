/**
 * Which agent tool calls change a file on disk (issue #440).
 *
 * One answer for every consumer of a `hook.event` that reacts to an edit: main's
 * diff refresh push, the renderer's auto-opened diff tab and the explorer's
 * "an agent touched this" dots. They used to each carry their own list, spelled
 * the way Claude Code spells its tools (`Edit`, `Write`), so the same event did
 * different things depending on who read it.
 *
 * The comparison is case-insensitive because the agents that report through the
 * pipe do not share a spelling. Claude Code (and Grok, and Qwen after the hook
 * helper's translation) says `Edit` / `Write`; pi's extension forwards pi's own
 * tool names, `edit` / `write`; OpenCode's `tool.execute.after` forwards `edit`,
 * `write` and `patch`. Matching only the capitalised names is what left the
 * "Auto-open diff tab on agent edits" setting doing nothing at all under pi.
 *
 * `Update` is how Claude Code labels an Edit in its UI and has been seen in
 * payloads; `apply_patch` is Codex's and OpenCode's patch tool.
 */
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'update',
  'patch',
  'apply_patch',
]);

/** True when `tool` names an agent tool whose completion changed a file. */
export function isFileEditTool(tool: unknown): boolean {
  return typeof tool === 'string' && FILE_EDIT_TOOLS.has(tool.trim().toLowerCase());
}
