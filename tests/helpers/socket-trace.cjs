// Preloaded into a pipe client under test (`node --require`). Logs, in order,
// the reply arriving on the client's own connection and the client ending or
// destroying it — the sequence pipe-client-latency.test.ts asserts. Only
// sockets the client opened are traced, never its stdio.
const fs = require('fs');
const net = require('net');

const log = process.env.WMUX_SOCKET_TRACE;
const traced = new WeakSet();
const note = (what) => { try { fs.appendFileSync(log, what + '\n'); } catch { /* never break the client */ } };

for (const name of ['connect', 'createConnection']) {
  const original = net[name];
  net[name] = function traceConnection(...args) {
    const socket = original.apply(this, args);
    traced.add(socket);
    return socket;
  };
}

const { emit, end, destroy } = net.Socket.prototype;
net.Socket.prototype.emit = function traceEmit(event, ...args) {
  if (event === 'data' && traced.has(this)) note('data');
  return emit.call(this, event, ...args);
};
net.Socket.prototype.end = function traceEnd(...args) {
  if (traced.has(this)) note('end');
  return end.apply(this, args);
};
net.Socket.prototype.destroy = function traceDestroy(...args) {
  if (traced.has(this)) note('destroy');
  return destroy.apply(this, args);
};
