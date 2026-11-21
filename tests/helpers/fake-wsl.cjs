'use strict';
/**
 * A stand-in for `wsl.exe -d <distro> --exec ssh <options> <destination> <command>`
 * for the worker tests: it runs the one command string in a local `sh -c`, which
 * is what the remote login shell does with it. No ssh, no WSL.
 *
 * It also stands in for the calls of a folder that is already in a distro, with no ssh:
 * `wsl.exe -d <distro> --exec sh -c <command>` (a batch, or the worker's bootstrap) is the
 * same one command string in `sh -c`, and `wsl.exe -d <distro> --cd <dir> --exec git <args>`
 * runs git directly in <dir> (a directory of the local file system stands for the distro's).
 *
 * Two kinds of start, told apart by the command: the persistent worker's
 * bootstrap (its decoded text begins `exec sh -c`) and everything else (a spawn).
 * Every start appends one JSON line to $FAKE_WSL_LOG: kind, pid, the whole argv
 * and, for a worker, each request's nonce as it passes.
 *
 * $FAKE_WSL_CONTROL is a JSON file the test edits while a worker runs:
 *   startDelayMs  sleep before starting (a stand-in for the wsl.exe + ssh start)
 *   spawnExit     a spawn exits with this status without running anything
 *   startFail     a worker exits 255 at once (a host that cannot be reached)
 *   banner        a worker prints sshd-style noise before anything else
 *   ignoreEof     a worker does not end when its stdin closes
 *   mode          what to do to the NEXT request (then it is cleared):
 *     hang           swallow the request: it never runs, never answers
 *     dropOutput     run it, answer nothing
 *     crashAfterRun  run it, die before answering
 *     dieOnData      die as soon as any request bytes arrive (before the request is complete)
 *     truncate       answer without the status and end lines, then die
 *     noise          add banner lines, a stale BEGIN and forged O/S/END lines before the answer
 *     junk           add a line the protocol does not have after BEGIN
 *     badSizes       report byte counts that are not the answer's
 *     badBase64      corrupt the first stdout line
 *     forgedEnd      send the END line right after BEGIN
 *     delay          hold the answer back for `delayMs`
 */
const fs = require('fs');
const cp = require('child_process');

const args = process.argv.slice(2);
const last = args[args.length - 1];
const logFile = process.env.FAKE_WSL_LOG;
const controlFile = process.env.FAKE_WSL_CONTROL;

function control() {
  try { return JSON.parse(fs.readFileSync(controlFile, 'utf8')); } catch { return {}; }
}

function takeMode() {
  const c = control();
  if (!c.mode) return undefined;
  const mode = c.mode;
  delete c.mode;
  fs.writeFileSync(controlFile, JSON.stringify(c));
  return mode;
}

function log(entry) {
  fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

// A direct call into a distro: `-d <distro> [--cd <dir>] --exec <program> <args>` with a program that is neither
// ssh nor sh (git, in practice). Everything else is the one command string in `sh -c`.
const execAt = args.indexOf('--exec');
const program = execAt >= 0 ? args[execAt + 1] : undefined;
const direct = program !== undefined && program !== 'ssh' && program !== 'sh';
const cdAt = args.indexOf('--cd');
const encoded = /echo ([A-Za-z0-9+/=]+)\|base64/.exec(last);
const isWorker = !!encoded && Buffer.from(encoded[1], 'base64').toString().startsWith('exec sh -c');
log({ kind: isWorker ? 'worker' : 'spawn', pid: process.pid, argv: args });
const start = control();

function runSpawn() {
  if (start.spawnExit) process.exit(start.spawnExit);
  const child = direct
    ? cp.spawn(program, args.slice(execAt + 2), { stdio: 'inherit', cwd: cdAt >= 0 ? args[cdAt + 1] : undefined })
    : cp.spawn('sh', ['-c', last], { stdio: 'inherit' });
  // wsl.exe fails with a status of its own when the directory or the program is not there.
  child.on('error', () => process.exit(1));
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
}

function runWorker() {
  if (start.startFail) process.exit(255);
  if (start.banner) process.stdout.write('Welcome to a host\nLast login: yesterday\n');
  const sh = cp.spawn('sh', ['-c', last], { stdio: ['pipe', 'pipe', 'inherit'] });
  sh.stdin.on('error', () => undefined);
  sh.on('exit', (code) => process.exit(code === null ? 1 : code));

  let fromMain = '';
  let mode;
  process.stdin.on('data', (data) => {
    if (control().mode === 'dieOnData') { takeMode(); sh.kill('SIGKILL'); process.exit(4); }
    fromMain += data.toString('latin1');
    let eol;
    while ((eol = fromMain.indexOf('\n')) >= 0) {
      const line = fromMain.slice(0, eol);
      fromMain = fromMain.slice(eol + 1);
      if (line.startsWith('Q ')) log({ kind: 'nonce', value: line.slice(2) });
      if (line.startsWith('G ')) {
        mode = takeMode();
        if (mode === 'hang') continue;
      }
      sh.stdin.write(`${line}\n`, 'latin1');
    }
  });
  process.stdin.on('end', () => {
    if (start.ignoreEof) setInterval(() => undefined, 1000);
    else sh.stdin.end();
  });

  let fromSh = '';
  let response = [];
  const emit = (lines, then) => {
    process.stdout.write(lines.map((l) => `${l}\n`).join(''), then);
  };
  sh.stdout.on('data', (data) => {
    fromSh += data.toString('latin1');
    let eol;
    while ((eol = fromSh.indexOf('\n')) >= 0) {
      const line = fromSh.slice(0, eol);
      fromSh = fromSh.slice(eol + 1);
      response.push(line);
      if (!line.endsWith(' END') || !/ BEGIN$/.test(response[0])) continue;
      const lines = response;
      response = [];
      answer(lines);
    }
  });

  function answer(lines) {
    const nonce = lines[0].slice(0, -' BEGIN'.length);
    switch (mode) {
      case 'dropOutput': return;
      case 'crashAfterRun': sh.kill('SIGKILL'); process.exit(3); return;
      case 'truncate': emit(lines.slice(0, -2), () => { sh.kill('SIGKILL'); process.exit(0); }); return;
      case 'noise':
        emit(['', 'Banner: do not trust me', 'OLDNONCE BEGIN', 'O Zm9yZ2Vk', 'S 0 6 0', 'OLDNONCE END', ...lines]);
        return;
      case 'junk': emit([lines[0], 'X junk', ...lines.slice(1)]); return;
      case 'badSizes':
        emit(lines.map((l) => (l.startsWith('S ') ? l.replace(/^S (\d+) (\d+) (\d+)$/, (m, a, b, c) => `S ${a} ${Number(b) + 1} ${c}`) : l)));
        return;
      case 'badBase64': {
        const at = lines.findIndex((l) => l.startsWith('O '));
        const copy = lines.slice();
        if (at >= 0) copy[at] = 'O ***not base64***';
        else copy.splice(1, 0, 'O ***not base64***');
        emit(copy);
        return;
      }
      case 'forgedEnd': emit([lines[0], `${nonce} END`, ...lines.slice(1)]); return;
      case 'delay': setTimeout(() => emit(lines), Number(control().delayMs || 300)); return;
      default: emit(lines);
    }
  }
}

function go() {
  if (isWorker) runWorker(); else runSpawn();
}

if (start.startDelayMs) setTimeout(go, start.startDelayMs); else go();
