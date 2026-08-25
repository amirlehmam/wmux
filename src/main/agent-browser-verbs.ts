/**
 * wmux browser verb → agent-browser argv.
 *
 * Deliberately PURE and I/O-free: this is the piece most likely to drift as
 * agent-browser's CLI evolves, so it must be exhaustively testable without a
 * daemon, a Chrome, or an Electron.
 *
 * Returns an argv ARRAY, never a shell string. Callers pass it straight to
 * execFile (see `agent-browser-cli.ts`). `params` originates from a pipe
 * command an agent controls, so a joined string here would be a
 * command-injection hole.
 */

/**
 * wmux refs are `e12`; agent-browser wants `@e12`. Anything that is not a bare
 * wmux ref is passed through untouched, because agent-browser accepts CSS and
 * text selectors in the same position.
 */
export function normaliseRef(ref: string): string {
  return /^e\d+$/.test(ref) ? `@${ref}` : ref;
}

/**
 * `click`/`type`/`fill` all act ON an element — there is no "whole page"
 * fallback the way `get_text` has `read`. A caller that omits `ref` is a bug
 * upstream (a pipe command missing a required param), and putting `undefined`
 * into the argv array would silently spawn `agent-browser click undefined`
 * instead of surfacing that bug. -32602 is the JSON-RPC code for invalid
 * params, matching what the web engine would reject the same call with.
 */
function requireRef(method: string, p: any): string {
  if (typeof p.ref !== 'string' || p.ref.length === 0) {
    throw Object.assign(new Error(`${method} requires a "ref" param`), { rpcCode: -32602 });
  }
  return normaliseRef(p.ref);
}

export function toAgentBrowserArgv(method: string, params: any, session: string): string[] {
  const p = params ?? {};
  const head = ['--session', session];
  const ref = typeof p.ref === 'string' ? normaliseRef(p.ref) : undefined;

  switch (method) {
    case 'browser.navigate':  return [...head, 'open', String(p.url ?? '')];
    case 'browser.snapshot':  return [...head, 'snapshot'];
    case 'browser.click':     return [...head, 'click', requireRef(method, p)];
    case 'browser.type':      return [...head, 'type', requireRef(method, p), String(p.text ?? '')];
    case 'browser.fill':      return [...head, 'fill', requireRef(method, p), String(p.value ?? '')];
    // No ref means "the whole page" in wmux. agent-browser spells that `read`,
    // which returns agent-readable text rather than a raw innerText dump.
    case 'browser.get_text':  return ref ? [...head, 'get', 'text', ref] : [...head, 'read'];
    case 'browser.screenshot':
      return [...head, 'screenshot', ...(p.fullPage ? ['--full'] : []), '--json'];
    case 'browser.eval':      return [...head, 'eval', String(p.js ?? '')];
    case 'browser.wait':
      // Unlike click/type/fill, `wait` has no single natural target: a ref
      // waits for an element, a timeout waits for time to pass. There is no
      // sane default for either — a `?? 1000` fallback would invent a delay
      // the caller never asked for and mask a pipe command that dropped a
      // param. So both omitted is a caller bug, same as a missing ref above,
      // and `timeout: 0` is a legitimate ("don't wait") value that must not
      // be treated as falsy.
      //
      // KNOWN ENGINE DIVERGENCE: `wmux browser wait <ref> [ms]` (see
      // src/cli/wmux.ts) sends ref AND timeout together — the ms bounds how
      // long to wait for that element. In `web` mode both reach
      // cdpBridge.wait(ref, timeout) and the timeout is honoured. agent-browser's
      // CLI has no equivalent: `wait <selector>` takes no per-call --timeout
      // (checked against its README — only a *global* env-var default,
      // AGENT_BROWSER_DEFAULT_TIMEOUT, applies, with no per-invocation override).
      // A caller-supplied timeout alongside a ref is therefore unrepresentable
      // in argv and is deliberately dropped — ref wins. This is a real, visible
      // behavioural gap between the two engines and needs a line in the docs
      // task; it is not something this pure function can close.
      if (ref) return [...head, 'wait', ref];
      if (typeof p.timeout === 'number') return [...head, 'wait', String(p.timeout)];
      throw Object.assign(new Error(`${method} requires a "ref" or a "timeout" param`), { rpcCode: -32602 });
    case 'browser.back':      return [...head, 'back'];
    case 'browser.forward':   return [...head, 'forward'];
    case 'browser.reload':    return [...head, 'reload'];
    default:
      // Same code the web engine uses, so a caller cannot tell the engines
      // apart by their error for an unsupported verb.
      throw Object.assign(new Error(`Unknown: ${method}`), { rpcCode: -32601 });
  }
}
