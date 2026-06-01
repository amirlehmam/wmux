// wmux-plugin-version: 2
// wmux OpenCode plugin — bridges OpenCode hooks/events to the wmux sidebar.
// Auto-installed by wmux to ~/.config/opencode/plugin/wmux.js.
// No-ops entirely outside wmux (WMUX !== '1').
const { execFile } = require("node:child_process");

function wmux(args) {
  // Fire-and-forget; never block or throw into OpenCode.
  try {
    const cli = process.env.WMUX_CLI;
    const file = cli ? process.execPath : "wmux";
    const argv = cli ? [cli, ...args] : args;
    execFile(file, argv, { windowsHide: true }, () => {});
  } catch {}
}

export const WmuxPlugin = async () => {
  if (process.env.WMUX !== "1") return {};
  const surface = process.env.WMUX_SURFACE_ID;
  if (!surface) return {};

  // message.part.updated fires per streaming delta (many per second). Throttle
  // the "active" pings so we don't spawn a CLI process for every token.
  let lastActivePing = 0;
  const pingActive = () => {
    const now = Date.now();
    if (now - lastActivePing < 1000) return;
    lastActivePing = now;
    wmux(["agent-activity", "--surface", surface, "--active"]);
  };
  const activeTool = (input) => {
    const tool = String((input && input.tool) || "");
    const args = ["agent-activity", "--surface", surface, "--active"];
    if (tool) args.push("--tool", tool);
    wmux(args);
  };

  return {
    "tool.execute.after": async (input) => {
      const tool = String((input && input.tool) || "");
      if (tool) wmux(["hook", "--event", "PostToolUse", "--tool", tool]);
      activeTool(input);
    },
    "tool.execute.before": async (input) => {
      activeTool(input);
    },
    event: async ({ event }) => {
      if (!event || !event.type) return;
      if (event.type === "session.idle") {
        wmux(["agent-activity", "--surface", surface, "--done"]);
      } else if (event.type === "session.error") {
        wmux(["agent-activity", "--surface", surface, "--done"]);
      } else if (event.type === "message.part.updated") {
        pingActive();
      }
    },
    "shell.env": async (input, output) => {
      output.env.WMUX = "1";
      output.env.WMUX_SURFACE_ID = surface;
      if (process.env.WMUX_PIPE) output.env.WMUX_PIPE = process.env.WMUX_PIPE;
      if (process.env.WMUX_CLI) output.env.WMUX_CLI = process.env.WMUX_CLI;
    },
  };
};
