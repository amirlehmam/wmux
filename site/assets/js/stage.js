/*
 * The hero's faux wmux window. One story, about 14 s:
 * three agents work, Codex stops to ask, the sidebar and a notification say so,
 * Ctrl+Shift+B jumps to it, the answer lands and the browser panel shows the result.
 *
 * Every string inside renders at the page's body size, so the page keeps its three font sizes.
 * The stage is recomposed per width (see stageSetMode) rather than scaled down to fit.
 * Reduced motion and off-screen show the poster beat: the agent waiting, the notification up.
 */
"use strict";

const stageEl = document.getElementById("stage");

function stagePart(name) {
  return stageEl.querySelector(`[data-st="${name}"]`);
}

// The stage is recomposed for its width, never shrunk past legibility:
//   900px and up: the desktop window, scaled no lower than 0.85 and widened so it reflows
//                 into the space the scale gives back (three panes from 70em, two below).
//   under 900px:  the compact window at scale 1, the sidebar and the one pane that matters,
//                 side by side from 560px, stacked below.
const STAGE_MIN_SCALE = 0.85;

function stageSetMode(wrap) {
  const w = wrap.clientWidth;
  const compact = w < 900;
  stageEl.classList.toggle("is-compact", compact);
  stageEl.classList.toggle("is-side", compact && w >= 560);
  stageEl.style.transform = "";
  if (compact) {
    stageEl.classList.remove("is-medium");
    stageEl.style.inlineSize = `${w}px`;
    stageFitCompact();
    wrap.style.height = `${stageEl.offsetHeight}px`;
    return;
  }
  stageEl.style.blockSize = "";
  const em = parseFloat(getComputedStyle(stageEl).fontSize) || 16;
  const scale = Math.min(1, Math.max(STAGE_MIN_SCALE, w / (80 * em)));
  const width = w / scale;
  stageEl.style.inlineSize = `${width}px`;
  stageEl.classList.toggle("is-medium", width / em < 70);
  if (scale < 1) stageEl.style.transform = `scale(${scale})`;
  wrap.style.height = `${Math.round(stageEl.offsetHeight * scale)}px`;
}

// The compact window is as tall as the Codex pane's fullest transcript (every line, the question with
// both options), so no frame shows a band of empty terminal under a few lines. Measured in one
// synchronous pass: the measuring class is added and removed before the browser paints.
function stageFitCompact() {
  stageEl.style.blockSize = "";
  const pane = stageEl.querySelector(".pane--p2");
  const head = pane.querySelector(".pane__head");
  const term = pane.querySelector(".term");
  stageEl.classList.add("is-measure");
  const needed = term.offsetHeight;
  stageEl.classList.remove("is-measure");
  const available = pane.clientHeight - head.offsetHeight;
  const em = parseFloat(getComputedStyle(stageEl).fontSize) || 16;
  stageEl.style.blockSize = `${Math.ceil(stageEl.offsetHeight + needed - available + 0.4 * em)}px`;
}

function stageSleep(ms, run) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (run.alive ? resolve() : reject(new Error("stopped"))), ms);
    run.timers.push(t);
  });
}

function stageLines(term) {
  return [...stageEl.querySelectorAll(`[data-term="${term}"] > .ln:not([data-st]):not(.seed)`)];
}

function stageSetWorkspace(state) {
  stageEl.querySelector('[data-ws="shop"]').dataset.state = state;
  stagePart("p2-dot").dataset.state = state;
  stagePart("count").textContent = state === "working" ? "2" : "1";
}

function stageFocus(pane) {
  stageEl.querySelectorAll(".pane").forEach((p) => p.classList.toggle("is-focus", p.dataset.pane === pane));
}

function stageReset() {
  // Seeded lines are each pane's resting history: no frame ever shows an empty pane.
  stageEl.querySelectorAll(".ln").forEach((l) => l.classList.toggle("on", l.classList.contains("seed")));
  ["ask", "toast", "keys"].forEach((n) => stagePart(n).classList.remove("on", "press", "answered"));
  stagePart("page").classList.remove("has-status", "is-dim");
  stageSetWorkspace("working");
  stageFocus("p1");
}

function stagePoster() {
  stageReset();
  ["p1", "p2", "p3"].forEach((t) => stageLines(t).forEach((l) => l.classList.add("on")));
  stagePart("ask").classList.add("on");
  stagePart("toast").classList.add("on");
  stageSetWorkspace("blocked");
}

async function stageWorkBeat(run) {
  const p1 = stageLines("p1");
  const p2 = stageLines("p2");
  const p3 = stageLines("p3");
  const steps = Math.max(p1.length, p2.length, p3.length);
  for (let i = 0; i < steps; i++) {
    [p2[i], p1[i], p3[i]].filter(Boolean).forEach((l) => l.classList.add("on"));
    await stageSleep(520, run);
  }
}

async function stageAskBeat(run) {
  stagePart("ask").classList.add("on");
  stageSetWorkspace("blocked");
  await stageSleep(650, run);
  stagePart("toast").classList.add("on");
  await stageSleep(1500, run);
  const keys = stagePart("keys");
  keys.classList.add("on");
  await stageSleep(520, run);
  keys.classList.add("press");
  stageFocus("p2");
  await stageSleep(200, run);
  keys.classList.remove("press");
  await stageSleep(700, run);
  keys.classList.remove("on");
}

async function stageAnswerBeat(run) {
  stagePart("toast").classList.remove("on");
  stagePart("ask").classList.add("answered");
  stageSetWorkspace("working");
  await stageSleep(450, run);
  stagePart("after1").classList.add("on");
  await stageSleep(700, run);
  const url = stagePart("url");
  const page = stagePart("page");
  url.classList.add("is-reload");
  page.classList.add("is-dim");
  await stageSleep(500, run);
  page.classList.remove("is-dim");
  page.classList.add("has-status");
  url.classList.remove("is-reload");
  await stageSleep(500, run);
  stagePart("after2").classList.add("on");
  await stageSleep(450, run);
  stageSetWorkspace("done");
  stagePart("prompt").classList.add("on");
}

async function stageLoop(run) {
  while (run.alive) {
    stageReset();
    await stageSleep(500, run);
    await stageWorkBeat(run);
    await stageAskBeat(run);
    await stageSleep(400, run);
    await stageAnswerBeat(run);
    await stageSleep(3200, run);
    stageEl.style.opacity = "0.25";
    await stageSleep(380, run);
    stageEl.style.opacity = "";
  }
}

function stageInit() {
  if (!stageEl) return;
  const wrap = stageEl.parentElement;
  stageEl.style.transition = "opacity 0.35s ease";
  stageSetMode(wrap);
  new ResizeObserver(() => stageSetMode(wrap)).observe(wrap);
  // The stage is sized in em: re-measure once the web fonts have replaced the fallback.
  document.fonts?.ready.then(() => stageSetMode(wrap));

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let run = null;
  const stop = () => {
    if (!run) return;
    run.alive = false;
    run.timers.forEach(clearTimeout);
    run = null;
    stageEl.style.opacity = "";
  };
  const start = () => {
    if (run || reduced.matches || document.hidden) return;
    run = { alive: true, timers: [] };
    stageLoop(run).catch(() => {});
  };
  let inView = false;
  const sync = () => {
    if (inView && !document.hidden && !reduced.matches) start();
    else { stop(); stagePoster(); }
  };
  stagePoster();
  new IntersectionObserver(([e]) => { inView = e.isIntersecting; sync(); }, { threshold: 0.2 }).observe(wrap);
  document.addEventListener("visibilitychange", sync);
  reduced.addEventListener("change", sync);
}

stageInit();
