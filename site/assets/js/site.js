/* wmux.org page behaviour: tooltips, mobile sheet, thumb CTA, copy buttons, reveals, film, footer accordions. */
"use strict";

const wmuxReduced = matchMedia("(prefers-reduced-motion: reduce)");
const wmuxFine = matchMedia("(hover: hover) and (pointer: fine)");

/* ---------- Tooltips: hover (fine pointers), keyboard focus and tap ---------- */
function placeTip(btn, pop) {
  const r = btn.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const left = Math.max(12, Math.min(r.left + r.width / 2 - pw / 2, vw - pw - 12));
  let top = r.bottom + 6;
  if (top + ph > innerHeight - 12) top = Math.max(12, r.top - ph - 6);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

/* Every info button is named "More information" plus its subject (the agent, the feature, the table cell),
   so a screen reader's button list can tell them apart. aria-labelledby reads the live text,
   so the name follows a language switch without another pass. */
let wmuxTipSubjectSeq = 0;

function ensureId(el, prefix) {
  if (!el.id) el.id = `${prefix}-${++wmuxTipSubjectSeq}`;
  return el.id;
}

function tipSubjects(btn) {
  const cell = btn.closest("td");
  if (cell) {
    const row = cell.closest("tr");
    const col = cell.closest("table")?.querySelectorAll("thead th")[cell.cellIndex];
    return [col, row?.querySelector("th")];
  }
  const owner = btn.closest(".logo-cell, .cell__title, .agents__label, .hero__meta li, .install__foot");
  if (!owner) return [];
  return [owner.querySelector(".name, h3, .mono, [data-i18n]")];
}

function nameTip(btn) {
  const subjects = tipSubjects(btn).filter(Boolean);
  if (!subjects.length) return;
  const ids = subjects.map((el) => ensureId(el, "tip-subject"));
  btn.setAttribute("aria-labelledby", [ensureId(btn, "tip-btn"), ...ids].join(" "));
}

function bindTip(btn) {
  const pop = document.getElementById(btn.dataset.tip);
  if (!pop || typeof pop.showPopover !== "function") return;
  nameTip(btn);
  btn.setAttribute("aria-describedby", pop.id);
  btn.setAttribute("aria-expanded", "false");
  let hoverTimer = 0;
  const isOpen = () => pop.matches(":popover-open");
  const show = () => {
    if (!isOpen()) {
      pop.showPopover();
    }
    placeTip(btn, pop);
  };
  const hide = () => { if (isOpen()) pop.hidePopover(); };
  pop.addEventListener("toggle", (e) => btn.setAttribute("aria-expanded", String(e.newState === "open")));
  // A tap on an open tip's trigger light-dismisses the popover before the click lands,
  // so the click decides from the state recorded at pointerdown, not from isOpen().
  let openAtPointerDown = null;
  btn.addEventListener("pointerdown", () => { openAtPointerDown = isOpen(); });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const fromHover = Boolean(btn.dataset.hovered);
    delete btn.dataset.hovered;
    const wasOpen = openAtPointerDown ?? isOpen();
    openAtPointerDown = null;
    if (wasOpen && !fromHover) hide(); else show();
  });
  btn.addEventListener("pointerenter", () => {
    if (!wmuxFine.matches) return;
    clearTimeout(hoverTimer);
    btn.dataset.hovered = "1";
    show();
  });
  btn.addEventListener("pointerleave", () => {
    if (!wmuxFine.matches) return;
    hoverTimer = setTimeout(() => { delete btn.dataset.hovered; hide(); }, 120);
  });
  btn.addEventListener("focus", () => { if (btn.matches(":focus-visible")) show(); });
  btn.addEventListener("blur", hide);
}

// An open tooltip follows its trigger while the page scrolls, and closes once the trigger leaves the screen.
function followOpenTips() {
  document.querySelectorAll(".tip__body:popover-open").forEach((pop) => {
    const btn = document.querySelector(`.tip__btn[data-tip="${pop.id}"]`);
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) pop.hidePopover();
    else placeTip(btn, pop);
  });
}

function initTips() {
  document.querySelectorAll(".tip__btn[data-tip]").forEach(bindTip);
  addEventListener("scroll", followOpenTips, { passive: true });
  addEventListener("resize", followOpenTips, { passive: true });
}

/* ---------- Mobile sheet ---------- */
function initSheet() {
  const sheet = document.getElementById("sheet");
  const menuBtn = document.querySelector(".menu-btn");
  if (!sheet || !menuBtn) return;
  const open = (on) => {
    sheet.dataset.open = String(on);
    menuBtn.setAttribute("aria-expanded", String(on));
    document.documentElement.style.overflow = on ? "hidden" : "";
    if (on) sheet.querySelector("nav a")?.focus();
    else menuBtn.focus({ preventScroll: true });
  };
  menuBtn.addEventListener("click", () => open(true));
  sheet.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]") || e.target.closest("nav a")) open(false);
  });
  // The sheet is aria-modal: Tab and Shift+Tab wrap inside its panel while it is open.
  const panel = sheet.querySelector(".sheet__panel");
  const focusables = () => [...panel.querySelectorAll("a[href], button:not([disabled])")];
  addEventListener("keydown", (e) => {
    if (sheet.dataset.open !== "true") return;
    if (e.key === "Escape") { open(false); return; }
    if (e.key !== "Tab") return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const inside = panel.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
  });
}

/* ---------- Thumb CTA: shown once the hero CTA has scrolled away, hidden over the footer ---------- */
function initThumb() {
  const thumb = document.getElementById("thumb-cta");
  const heroCta = document.querySelector(".hero__cta");
  const footer = document.querySelector(".site-footer");
  if (!thumb || !heroCta || !("IntersectionObserver" in window)) return;
  let heroVisible = true;
  let footerVisible = false;
  // While the thumb CTA shows, the header's own Download steps aside (one primary CTA on screen).
  const sync = () => {
    const hidden = heroVisible || footerVisible;
    thumb.dataset.hidden = String(hidden);
    document.documentElement.classList.toggle("thumb-on", !hidden);
  };
  new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting || e.boundingClientRect.top > 0; sync(); }).observe(heroCta);
  if (footer) new IntersectionObserver(([e]) => { footerVisible = e.isIntersecting; sync(); }).observe(footer);
}

/* ---------- Copy buttons ---------- */
function legacyCopy(text) {
  const ta = Object.assign(document.createElement("textarea"), { value: text });
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return legacyCopy(text); }
}

function initCopy() {
  const status = document.getElementById("copy-status");
  document.querySelectorAll(".copy[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!(await copyText(btn.dataset.copy))) return;
      btn.dataset.copied = "true";
      if (status) status.textContent = window.wmuxT ? window.wmuxT("install.copied") : "Copied";
      setTimeout(() => { btn.dataset.copied = "false"; }, 1600);
    });
  });
}

/* ---------- Section reveals ---------- */
function initReveals() {
  const reveals = document.querySelectorAll(".reveal");
  if (wmuxReduced.matches || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.filter((e) => e.isIntersecting).forEach((e) => { e.target.classList.add("in"); io.unobserve(e.target); });
  }, { rootMargin: "0px 0px -8% 0px" });
  reveals.forEach((el) => io.observe(el));
}

/* ---------- Film: silent loop as the preview, full film with sound on click ---------- */
function initFilm() {
  const film = document.getElementById("film-video");
  const preview = document.getElementById("film-preview");
  const loop = document.getElementById("film-loop");
  const play = document.getElementById("film-play");
  if (!film || !preview || !loop || !play) return;
  preview.hidden = false;
  film.setAttribute("tabindex", "-1");
  const playLoop = () => {
    if (wmuxReduced.matches) return;
    loop.preload = "auto";
    loop.play().catch(() => {});
  };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => {
      if (preview.hidden) return;
      if (e.isIntersecting) playLoop(); else loop.pause();
    }, { threshold: 0.25 }).observe(preview);
  }
  play.addEventListener("click", () => {
    loop.pause();
    preview.hidden = true;
    film.removeAttribute("tabindex");
    film.preload = "auto";
    film.play().catch(() => {});
    film.focus({ preventScroll: true });
  });
}

/* ---------- Footer columns: open on wide screens, accordions on phones ---------- */
function initFooter() {
  const narrow = matchMedia("(max-width: 719px)");
  const cols = document.querySelectorAll(".footer-col");
  const sync = () => cols.forEach((d) => { d.open = !narrow.matches; });
  sync();
  narrow.addEventListener("change", sync);
  cols.forEach((d) => {
    d.querySelector("summary")?.addEventListener("click", (e) => { if (!narrow.matches) e.preventDefault(); });
  });
}

initTips();
initSheet();
initThumb();
initCopy();
initReveals();
initFilm();
initFooter();
