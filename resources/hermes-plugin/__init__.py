# wmux-plugin-version: 2
"""wmux status reporting for Hermes Agent.

Auto-installed by wmux to <HERMES_HOME>/plugins/wmux/ (hermes-context.ts) under
the Status hooks consent, and enabled with `hermes plugins enable wmux`.
No-ops entirely outside a wmux pane (WMUX != "1" or no WMUX_SURFACE_ID).

-- What it does ---------------------------------------------------------------

Hermes has no Claude-style settings.json hooks, but its plugin hooks cover the
same lifecycle. Each one is translated into the Claude Code hook event wmux
already understands and handed to wmux's own hook helper (wmux-hook.js, next to
$WMUX_CLI), so notifications, "Needs you", the sidebar's working/idle state, the
prompt log and the diff refresh all take the path Claude Code's hooks take:

  subagent_start           -> (marks the child session; sends nothing)
  on_session_start         -> SessionStart
  pre_llm_call             -> UserPromptSubmit  (a turn started; the human replied)
  pre_tool_call            -> PreToolUse
  post_tool_call           -> PostToolUse
  on_human_input_request   -> Notification      (approval, clarify, sudo, elicitation)
  on_session_end (a turn)  -> Stop              (completed, failed or interrupted)
  on_session_finalize      -> SessionEnd        (Hermes is exiting this session)

A block is retracted the way Claude Code's is (#399): the prompting tool call's
PostToolUse, matched by its `tool_use_id`, or the turn's Stop.

-- Rules ----------------------------------------------------------------------

- Never forward a session id. wmux files an id with no provider as Claude's,
  and a restore would type `claude --resume <hermes-id>`.
- Subagents (delegate_task) run in-process and fire the same hooks under their
  own session id. Their tool events carry `agent_id` so they never retract the
  main thread's block, their prompt is not a user prompt, and their turn end is
  SubagentStop, never the parent's Stop.
- Hook processes run one at a time, in order, on a worker thread: wmux orders
  reports by the time each helper process started, and two racing helpers
  could otherwise deliver a PreToolUse after the Stop that followed it.
- Nothing here may raise into Hermes or block a turn.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading

_MAX_PROMPT = 4000
_MAX_MESSAGE = 300
_TOOL_EVENTS = {"PreToolUse", "PostToolUse"}
# Queued tool events past which further ones are dropped (lifecycle events never are).
_TOOL_BACKLOG = 64

# Hermes tool name -> the Claude Code name wmux's sidebar and diff view know.
_TOOL_NAMES = {
    "terminal": "Bash",
    "read_file": "Read",
    "write_file": "Write",
    "patch": "Edit",
    "search_files": "Grep",
    "web_search": "WebSearch",
    "web_extract": "WebFetch",
    "skill_view": "Skill",
    "todo_list": "TodoWrite",
}
_EDIT_TOOLS = {"write_file", "patch"}

_NOTIFY = {
    # kind -> (notification_type, message prefix)
    "approval": ("permission_prompt", "Hermes needs your approval"),
    "sudo": ("permission_prompt", "Hermes needs your sudo password"),
    "clarify": ("elicitation_dialog", "Hermes has a question"),
    "elicitation": ("elicitation_dialog", "Hermes needs your input"),
}


def _active() -> bool:
    return os.environ.get("WMUX") == "1" and bool(os.environ.get("WMUX_SURFACE_ID"))


def _hook_command():
    """[runtime, wmux-hook.js] and the env to run it with, or None."""
    cli = os.environ.get("WMUX_CLI", "")
    if not cli:
        return None
    script = os.path.join(os.path.dirname(cli), "wmux-hook.js")
    if not os.path.isfile(script):
        return None
    env = dict(os.environ)
    node = os.environ.get("WMUX_NODE") or "node"
    if os.environ.get("WMUX_NODE_ELECTRON") == "1":
        env["ELECTRON_RUN_AS_NODE"] = "1"
    return [node, script], env


class _Reporter:
    def __init__(self, base, env):
        self._base = base
        self._env = env
        self._queue: "queue.Queue" = queue.Queue()
        self._lock = threading.Lock()
        self.children: set = set()
        # A main-thread turn is running. Tool events outside one come from
        # Hermes's post-turn background review fork, which shares the main
        # session id but fires no turn start or end, so it would leave the
        # pane "working" after the Stop.
        self.active = False
        threading.Thread(target=self._run, name="wmux-hooks", daemon=True).start()

    def send(self, event: str, payload: dict) -> None:
        if event in _TOOL_EVENTS:
            # Tool events are the only ones dropped when wmux falls behind:
            # a lost Stop, SessionEnd or Notification would strand the pane.
            if self._queue.qsize() >= _TOOL_BACKLOG:
                return
            self._queue.put_nowait((event, payload))
            return
        self._queue.put((event, payload))

    def flush(self, timeout: float = 8.0) -> None:
        done = threading.Event()
        self._queue.put((None, done))
        done.wait(timeout)

    def _run(self) -> None:
        while True:
            event, payload = self._queue.get()
            if event is None:
                payload.set()
                continue
            self._spawn(event, payload)

    def _spawn(self, event: str, payload: dict) -> None:
        flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW
        try:
            proc = subprocess.Popen(
                self._base + ["--event", event],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=self._env,
                creationflags=flags,
            )
            try:
                proc.communicate(json.dumps(payload).encode("utf-8"), timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        except Exception:
            pass

    def is_child(self, session_id) -> bool:
        """A subagent's session: one whose pre_llm_call named a parent.

        Only that positive evidence counts. A session id merely different from
        the last one seen is not a child: compaction continues the main
        session under a new id mid-turn.
        """
        sid = session_id if isinstance(session_id, str) else ""
        with self._lock:
            return bool(sid) and sid in self.children


_reporter = None


def _tool_payload(kwargs: dict, child: bool) -> dict:
    name = kwargs.get("tool_name") if isinstance(kwargs.get("tool_name"), str) else ""
    payload = {"tool_name": _TOOL_NAMES.get(name, name)}
    call_id = kwargs.get("tool_call_id")
    if isinstance(call_id, str) and call_id:
        payload["tool_use_id"] = call_id
    args = kwargs.get("args")
    if name in _EDIT_TOOLS and isinstance(args, dict) and isinstance(args.get("path"), str):
        payload["tool_input"] = {"file_path": args["path"]}
    if child:
        sid = kwargs.get("session_id")
        if isinstance(sid, str) and sid:
            payload["agent_id"] = sid[:128]
            payload["agent_type"] = "subagent"
    return payload


def _on_subagent_start(**kwargs):
    # Fires in the parent before the child runs, so the child's own
    # on_session_start (which carries no parent id) is recognised as a child's.
    sid = kwargs.get("child_session_id")
    if isinstance(sid, str) and sid:
        with _reporter._lock:
            _reporter.children.add(sid)


def _on_session_start(**kwargs):
    if _reporter.is_child(kwargs.get("session_id")):
        return
    _reporter.send("SessionStart", {})


def _on_pre_llm_call(**kwargs):
    sid = kwargs.get("session_id") if isinstance(kwargs.get("session_id"), str) else ""
    if kwargs.get("parent_session_id"):
        if sid:
            with _reporter._lock:
                _reporter.children.add(sid)
        return
    if _reporter.is_child(sid):
        return
    _reporter.active = True
    payload = {}
    msg = kwargs.get("user_message")
    if isinstance(msg, str) and msg.strip():
        payload["prompt"] = msg[:_MAX_PROMPT]
    _reporter.send("UserPromptSubmit", payload)


def _tool_event(event: str, kwargs: dict) -> None:
    if not _reporter.active:
        return
    _reporter.send(event, _tool_payload(kwargs, _reporter.is_child(kwargs.get("session_id"))))


def _on_pre_tool_call(**kwargs):
    _tool_event("PreToolUse", kwargs)
    return None


def _on_post_tool_call(**kwargs):
    _tool_event("PostToolUse", kwargs)


def _on_human_input_request(**kwargs):
    kind = kwargs.get("kind") if isinstance(kwargs.get("kind"), str) else ""
    ntype, text = _NOTIFY.get(kind, ("permission_prompt", "Hermes needs you"))
    prompt = kwargs.get("prompt")  # force-redacted by Hermes
    if isinstance(prompt, str) and prompt.strip():
        text = f"{text}: {' '.join(prompt.split())}"
    _reporter.send("Notification", {"message": text[:_MAX_MESSAGE], "notification_type": ntype})


def _on_session_end(**kwargs):
    sid = kwargs.get("session_id") if isinstance(kwargs.get("session_id"), str) else ""
    if _reporter.is_child(sid):
        with _reporter._lock:
            _reporter.children.discard(sid)
        _reporter.send("SubagentStop", {"agent_id": sid[:128], "agent_type": "subagent"})
        return
    _reporter.active = False
    _reporter.send("Stop", {})


def _on_session_finalize(**kwargs):
    sid = kwargs.get("session_id") if isinstance(kwargs.get("session_id"), str) else ""
    if _reporter.is_child(sid):
        return
    _reporter.send("SessionEnd", {})
    _reporter.flush()  # Hermes may be exiting: deliver before the daemon thread dies


_HOOKS = {
    "subagent_start": _on_subagent_start,
    "on_session_start": _on_session_start,
    "pre_llm_call": _on_pre_llm_call,
    "pre_tool_call": _on_pre_tool_call,
    "post_tool_call": _on_post_tool_call,
    "on_human_input_request": _on_human_input_request,
    "on_session_end": _on_session_end,
    "on_session_finalize": _on_session_finalize,
}


def _guarded(fn):
    def wrapper(**kwargs):
        try:
            fn(**kwargs)
        except Exception:
            pass
        return None
    wrapper.__name__ = fn.__name__
    return wrapper


def register(ctx):
    global _reporter
    if not _active():
        return
    command = _hook_command()
    if command is None:
        return
    _reporter = _Reporter(*command)
    for name, fn in _HOOKS.items():
        ctx.register_hook(name, _guarded(fn))
