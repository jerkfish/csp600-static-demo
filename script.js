// Frontend logic for the resume-job matching web prototype (redesign).
// Vanilla JS — no frameworks, no build step.
// API contract: GET /samples, GET /samples/{id}, POST /score, POST /rank,
//               POST /export, POST /api/related-jobs.
"use strict";

const $ = (id) => document.getElementById(id);

// Calibrated thresholds (midpoints of labels {0, 0.5, 1}) — used for colours
const THRESH_NO_FIT = 0.25;
const THRESH_GOOD_FIT = 0.75;

const GAUGE_LEN = 251.33; // semicircle r=80 arc length — matches style.css --gauge-len

const reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Score-band helpers — band hues drive gauges, meters, bars and badges.
// Bands: red = No Fit, yellow = Potential Fit, green = Good Fit.
function fitBand(score) {
  const s = clamp01(score);
  return s >= THRESH_GOOD_FIT ? "good" : s >= THRESH_NO_FIT ? "mid" : "low";
}
const BAND_TOKENS = { good: "good", mid: "warn", low: "bad" };
function bandToken(score) { return BAND_TOKENS[fitBand(score)]; }
function bandGradient(score) {
  const t = bandToken(score);
  return `linear-gradient(90deg, var(--${t}-deep), var(--${t}))`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function currentModel() {
  return $("modelSelect").value;
}

function currentModelName() {
  const sel = $("modelSelect");
  return sel.options[sel.selectedIndex].textContent;
}

// Escape user-controlled strings (e.g. upload filenames) before injecting into HTML.
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Simple deterministic hash for the related-jobs cache.
function hashText(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ---------------------------------------------------------------------------
// Toasts (replaces native alert() dialogs)
// ---------------------------------------------------------------------------
const TOAST_ICONS = {
  error: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>',
  info:  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/></svg>',
};

function showToast(message, kind = "error") {
  const region = $("toastRegion");
  if (!region) { alert(message); return; }
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  toast.innerHTML = `${TOAST_ICONS[kind] || TOAST_ICONS.info}<span></span>`;
  toast.querySelector("span").textContent = message;
  region.appendChild(toast);
  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 200ms";
    window.setTimeout(() => toast.remove(), 220);
  }, 5000);
}

// ---------------------------------------------------------------------------
// Button busy state
// ---------------------------------------------------------------------------
function setBusy(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.idleLabel === undefined) btn.dataset.idleLabel = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = busyLabel || "Working…";
  } else {
    btn.disabled = false;
    if (btn.dataset.idleLabel !== undefined) {
      btn.innerHTML = btn.dataset.idleLabel;
      delete btn.dataset.idleLabel;
    }
  }
}

// The redesign is light-only (cream canvas, ink text, orange/yellow accents);
// the dark theme and its toggle were removed by design.

// ---------------------------------------------------------------------------
// Micro-interaction: ripple + press feedback on primary buttons
// ---------------------------------------------------------------------------
document.querySelectorAll(".btn-ripple").forEach((btn) => {
  btn.addEventListener("pointerdown", (e) => {
    if (reducedMotion || e.button !== 0) return;
    const rect = btn.getBoundingClientRect();
    const d = Math.max(rect.width, rect.height);
    const span = document.createElement("span");
    span.className = "ripple";
    span.style.width = span.style.height = d + "px";
    span.style.left = (e.clientX - rect.left - d / 2) + "px";
    span.style.top = (e.clientY - rect.top - d / 2) + "px";
    btn.appendChild(span);
    span.addEventListener("animationend", () => span.remove());
  });
});

// ---------------------------------------------------------------------------
// Tab switching with sliding pill indicator + view cross-fade
// ---------------------------------------------------------------------------
const tabButtons = Array.from(document.querySelectorAll('.tab[data-mode]'));
const tabPill = $("tabPill");

function positionTabPill() {
  const active = document.querySelector('.tab[aria-selected="true"]');
  if (!active || !tabPill) return;
  tabPill.style.width = active.offsetWidth + "px";
  tabPill.style.transform = `translateX(${active.offsetLeft}px)`;
}

function switchView(mode) {
  tabButtons.forEach((b) => {
    const on = b.dataset.mode === mode;
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  positionTabPill();

  const views = { score: "scoreView", rank: "rankView", match: "matchView" };
  const show = $(views[mode] || "scoreView");
  Object.values(views).forEach((id) => {
    const v = $(id);
    if (!v) return;
    v.classList.add("d-none");
    v.classList.remove("view-enter");
  });
  show.classList.remove("d-none");
  void show.offsetWidth; // restart the enter animation
  show.classList.add("view-enter");
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.mode));
});

// Arrow-key navigation for the tablist (ARIA tabs pattern)
const tabsEl = document.querySelector(".tabs");
tabsEl.addEventListener("keydown", (e) => {
  const idx = tabButtons.indexOf(document.activeElement);
  if (idx === -1) return;
  let next = null;
  if (e.key === "ArrowRight") next = tabButtons[(idx + 1) % tabButtons.length];
  else if (e.key === "ArrowLeft") next = tabButtons[(idx - 1 + tabButtons.length) % tabButtons.length];
  if (next) { e.preventDefault(); next.focus(); switchView(next.dataset.mode); }
});

// ---------------------------------------------------------------------------
// Live char/word counters (debounced)
// ---------------------------------------------------------------------------
function bindCounter(textareaId, chipId) {
  const ta = $(textareaId);
  const chip = $(chipId);
  if (!ta || !chip) return;
  const update = () => {
    const len = ta.value.length;
    const words = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
    chip.textContent = len
      ? `${len.toLocaleString()} chars · ~${words} words`
      : "0 chars";
    chip.classList.add("live");
    clearTimeout(chip._t);
    chip._t = setTimeout(() => chip.classList.remove("live"), 700);
  };
  ta.addEventListener("input", debounce(update, 120));
  update();
  return update;
}

// ---------------------------------------------------------------------------
// Samples dropdown
// ---------------------------------------------------------------------------
async function loadSamples() {
  try {
    const resp = await fetch("/samples");
    const samples = await resp.json();
    if (!Array.isArray(samples)) return;
    const sel = $("sampleSelect");
    samples.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `Sample ${s.id} — ${s.label}`;
      sel.appendChild(opt);
    });
  } catch (err) {
    showToast("Could not load sample pairs: " + err.message);
  }
}

$("sampleSelect").addEventListener("change", async (e) => {
  if (!e.target.value) return;
  try {
    const resp = await fetch(`/samples/${e.target.value}`);
    const s = await resp.json();
    $("resumeText").value = s.resume;
    $("jdText").value = s.jd;
    updateCounters();
    $("scoreStatus").textContent = `Loaded sample ${s.id} — ${s.label}`;
  } catch (err) {
    showToast("Could not load sample: " + err.message);
  }
});

// ---------------------------------------------------------------------------
// File inputs: drop zones + filename chips with remove buttons
// ---------------------------------------------------------------------------
function bindDropzone(inputId, zoneId) {
  const input = $(inputId);
  const zone = $(zoneId);
  if (!input || !zone) return;
  // Clicking the zone opens the picker (except on the remove button)
  zone.addEventListener("click", (e) => {
    if (e.target.closest(".fc-remove")) return;
    input.click();
  });
  ["dragenter", "dragover"].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("dragover"); }));
  zone.addEventListener("drop", (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    if (input.multiple) {
      const dt = new DataTransfer();
      for (const f of input.files) dt.items.add(f);
      for (const f of files) dt.items.add(f);
      input.files = dt.files;
    } else if (files[0]) {
      const dt = new DataTransfer();
      dt.items.add(files[0]);
      input.files = dt.files;
    }
    input.dispatchEvent(new Event("change"));
  });
  return input;
}

function bindFileChip(inputId, nameId, removeId) {
  const input = $(inputId);
  const nameEl = $(nameId);
  const zone = input.closest(".dropzone");
  const chip = zone ? zone.querySelector(".file-chip") : null;
  const update = () => {
    const f = input.files && input.files[0];
    if (nameEl) nameEl.textContent = f ? f.name : "No file selected";
    if (chip) chip.classList.toggle("d-none", !f);
    if (zone) zone.classList.toggle("has-file", !!f);
  };
  input.addEventListener("change", update);
  const rm = $(removeId);
  if (rm) rm.addEventListener("click", () => { input.value = ""; update(); });
  return update;
}

// Ranked-file list with per-file remove + clear-all
function renderRankFiles() {
  const input = $("rankResumeFiles");
  const files = Array.from(input.files || []);
  const list = $("rankFileList");
  list.innerHTML = "";
  if (!files.length) return;
  files.forEach((f, i) => {
    const item = document.createElement("li");
    item.className = "file-item";
    item.style.setProperty("--d", Math.min(i * 40, 280) + "ms");
    const name = document.createElement("span");
    name.className = "file-item-name";
    name.textContent = f.name;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "fc-remove";
    rm.setAttribute("aria-label", `Remove ${f.name}`);
    rm.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    rm.addEventListener("click", () => {
      const dt = new DataTransfer();
      files.forEach((x, j) => { if (j !== i) dt.items.add(x); });
      input.files = dt.files;
      renderRankFiles();
    });
    item.append(name, rm);
    list.appendChild(item);
  });
  const clearItem = document.createElement("li");
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "link-btn";
  clear.textContent = `Clear (${files.length})`;
  clear.addEventListener("click", () => {
    input.value = "";
    renderRankFiles();
  });
  clearItem.appendChild(clear);
  list.appendChild(clearItem);
}

// ---------------------------------------------------------------------------
// Document "reading" overlay — choreographs the wait, never fakes the result.
// ---------------------------------------------------------------------------
const READER_STAGES = [
  "Extracting text…",
  "Tokenizing…",
  "Identifying skills & sections…",
  "Encoding with Bi-LSTM…",
  "Computing alignment…",
];

const Reader = {
  _token: 0,
  _stageTimer: null,
  _openedAt: 0,
  _lastPreview: "",

  open(title, sub) {
    this._token++;
    this._openedAt = performance.now();
    $("readerTitle").textContent = title;
    $("readerSub").textContent = sub;
    $("readerDoc").textContent = "";
    $("readerBarFill").style.width = "8%";
    $("reader").classList.remove("d-none");
  },

  close() {
    this.stop();
    $("reader").classList.add("d-none");
  },

  status(msg) {
    const el = $("readerStatus");
    el.textContent = msg;
    el.style.animation = "none";
    void el.offsetWidth; // restart fade/slide-in
    el.style.animation = "";
  },

  startCycling() {
    let i = 0;
    this.status(READER_STAGES[0]);
    this._stageTimer = setInterval(() => {
      i = (i + 1) % READER_STAGES.length;
      this.status(READER_STAGES[i]);
      $("readerBarFill").style.width = Math.min(92, 14 + i * 18) + "%";
    }, 2400);
  },

  stop() {
    clearInterval(this._stageTimer);
    this._token++;
  },

  // Word-by-word reveal of the preview text (skipped under reduced motion).
  async typewriter(text, step = 60) {
    const myToken = this._token;
    const pre = $("readerDoc");
    const words = text.trim().split(/\s+/).slice(0, 170);
    pre.textContent = "";
    if (!words.length) return;
    if (reducedMotion) { pre.textContent = words.join(" "); return; }
    for (let i = 0; i < words.length; i++) {
      if (myToken !== this._token) return; // superseded by finalize()
      pre.textContent = words.slice(0, i + 1).join(" ");
      await delay(step);
    }
  },

  // Called when the real /score response arrives: finish the choreography and
  // hide the overlay. The result itself is never fabricated — only revealed.
  async finalize(preview, highlightTokens) {
    this.stop();
    const pre = $("readerDoc");
    if (preview && preview.trim()) {
      pre.innerHTML = highlightText(preview, highlightTokens);
    }
    this.status("Alignment computed — rendering result…");
    $("readerBarFill").style.width = "100%";
    // Keep the reader visible for a beat (min total display, no fake waiting
    // beyond a short grace period so it never flashes).
    const elapsed = performance.now() - this._openedAt;
    if (elapsed < 1500) await delay(1500 - elapsed);
    this.close();
  },
};

function highlightText(text, tokens) {
  const set = new Set((tokens || []).map((t) => String(t).toLowerCase()));
  const esc = escapeHtml(text);
  if (!set.size) return esc;
  return esc.replace(/[A-Za-z0-9][A-Za-z0-9'-]*/g, (w) =>
    set.has(w.toLowerCase()) ? `<mark>${w}</mark>` : w);
}

// ---------------------------------------------------------------------------
// Score a single pair
// ---------------------------------------------------------------------------
$("scoreBtn").addEventListener("click", () => doScore());

$("spamTestBtn").addEventListener("click", () => {
  // Demo the keyword-stuffing guardrail: identical keyword spam on both sides,
  // scored with the adversarially-trained model.
  const spam = "python java sql agile team leadership python java sql agile " +
               "team leadership python java sql agile team leadership python java " +
               "sql agile team leadership python java sql agile team leadership " +
               "python java sql agile team leadership python java sql agile team " +
               "leadership python java sql agile team leadership";
  switchView("score");
  $("modelSelect").value = "adversarial";                    // hardened model
  $("resumeText").value = spam;
  $("jdText").value = spam;
  updateCounters();
  doScore();
});

function easeOutExpo(t) {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function animateNumber(el, target, dur = 1000) {
  if (reducedMotion) { el.textContent = target.toFixed(4); return; }
  const start = performance.now();
  const from = 0;
  function frame(now) {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = (from + (target - from) * easeOutExpo(t)).toFixed(4);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

async function doScore() {
  const hasResume = $("resumeText").value.trim() || $("resumeFile").files[0];
  const hasJd = $("jdText").value.trim() || $("jdFile").files[0];
  if (!hasResume || !hasJd) {
    showToast("Both a resume and a job description are required.", "error");
    return;
  }

  const btn = $("scoreBtn");
  const spinner = $("scoreSpinner");
  const status = $("scoreStatus");
  spinner.classList.remove("d-none");
  status.textContent = "Scoring…";
  setBusy(btn, true, "Scoring…");

  // --- Reading choreography ----------------------------------------------
  const resumeFile = $("resumeFile").files && $("resumeFile").files[0];
  const pasted = $("resumeText").value.trim();
  Reader.open(
    resumeFile ? resumeFile.name : "Pasted resume",
    resumeFile ? "Extracting and analysing document" : "Analysing pasted text",
  );
  Reader.startCycling();
  if (pasted) Reader.typewriter(pasted.slice(0, 600), 55);
  // For file uploads there is no preview yet — it arrives with the response.

  const fd = new FormData();
  fd.append("resume_text", $("resumeText").value);
  fd.append("jd_text", $("jdText").value);
  fd.append("model_name", currentModel());
  if (resumeFile) fd.append("resume_file", resumeFile);
  const jFile = $("jdFile").files[0];
  if (jFile) fd.append("jd_file", jFile);

  let resumeTextForJobs = pasted; // used by related jobs after scoring

  try {
    const resp = await fetch("/score", { method: "POST", body: fd });
    const data = await resp.json();
    if (data.error) {
      Reader.close();
      showToast(data.error, "error");
      return;
    }
    const highlightTokens = (data.evidence || []).map((e) => e.token);
    await Reader.finalize(data.resume_preview, highlightTokens);
    if (!resumeTextForJobs && data.resume_preview) {
      // Uploaded resume: the extracted preview is the best handle we have for
      // the related-jobs query without touching the backend contract.
      resumeTextForJobs = data.resume_preview;
    }
    renderScore(data);
    status.textContent = `Done — fit score ${data.score.toFixed(4)} with ${currentModelName()}.`;
    lastResumePreview = resumeTextForJobs;
    loadRelatedJobs(resumeTextForJobs);
  } catch (err) {
    Reader.close();
    showToast("Error: " + err.message);
  } finally {
    spinner.classList.add("d-none");
    setBusy(btn, false);
  }
}

function renderScore(data) {
  const wrap = $("scoreResult");
  wrap.classList.remove("d-none");
  wrap.classList.remove("view-enter");
  void wrap.offsetWidth;
  wrap.classList.add("view-enter");

  // --- Score: count-up number + arc gauge + colour band -------------------
  const score = clamp01(data.score);
  const band = fitBand(score);
  const colorVar = `var(--${bandToken(score)})`;

  const gauge = $("fitGauge");
  gauge.style.setProperty("--gauge-color", colorVar);   // solid fallback
  gauge.style.stroke = `url(#gauge-${band})`;           // band gradient
  $("fitScore").style.color = colorVar;
  $("fitGaugeWrap").setAttribute("aria-label", `Fit score ${score.toFixed(4)} — ${data.label}`);
  animateNumber($("fitScore"), score, 1000);
  requestAnimationFrame(() => {
    gauge.style.strokeDashoffset = (GAUGE_LEN * (1 - score)).toFixed(2);
  });

  // Badge pops in with a spring
  const badge = $("fitBadge");
  badge.textContent = data.label;
  badge.className = "badge pop " + (data.label_cls || "badge-neutral");

  // Meter needle + fill + accessible value
  const pct = Math.max(0, Math.min(100, score * 100));
  $("fitNeedle").style.left = pct + "%";
  $("fitMeterFill").style.width = pct + "%";
  $("fitMeterFill").style.background = bandGradient(score);
  $("fitMeter").setAttribute("aria-valuenow", data.score.toFixed(4));

  $("resumeTokCount").textContent = data.resume_tokens;
  $("jdTokCount").textContent = data.jd_tokens;

  // Keyword-density guardrail (slides in with a subtle shake)
  const warn = $("guardrailWarn");
  const kd = data.keyword_density;
  if (kd && kd.suspicious) {
    $("densityVal").textContent = (kd.density * 100).toFixed(1) + "%";
    const chips = $("guardrailTokens");
    chips.innerHTML = "";
    (kd.top_tokens || []).forEach((t) => {
      const chip = document.createElement("span");
      chip.className = "token-chip";
      // top_tokens is a list of [word, count] pairs
      chip.textContent = Array.isArray(t) ? `${t[0]} ×${t[1]}` : String(t);
      chips.appendChild(chip);
    });
    warn.classList.remove("d-none");
    warn.classList.remove("shake");
    void warn.offsetWidth;
    warn.classList.add("shake");
  } else {
    warn.classList.add("d-none");
  }

  // Section contribution — vanilla CSS bars, staggered fill
  const chart = $("sectionChart");
  chart.innerHTML = "";
  const sections = Array.isArray(data.sections) ? data.sections : [];
  if (!sections.length) {
    chart.innerHTML = '<p class="empty-note">No sections detected in the resume.</p>';
  } else {
    sections.forEach((s, i) => {
      const v = clamp01(s.score);
      const cls = v >= THRESH_GOOD_FIT ? "bar-good" : (v >= THRESH_NO_FIT ? "bar-mid" : "bar-low");
      const row = document.createElement("div");
      row.className = "bar-row";
      row.style.setProperty("--d", Math.min(i * 60, 400) + "ms");
      row.innerHTML =
        `<span class="bar-label" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>` +
        `<div class="bar-track"><div class="bar-fill ${cls}"></div></div>` +
        `<span class="bar-value">${s.score.toFixed(2)}</span>`;
      chart.appendChild(row);
      const fill = row.querySelector(".bar-fill");
      fill.style.transitionDelay = (80 + i * 70) + "ms";
      requestAnimationFrame(() => requestAnimationFrame(() => {
        fill.style.width = (v * 100).toFixed(1) + "%";
      }));
    });
  }

  // Matching evidence (top attended tokens), weighted + staggered
  const list = $("evidenceList");
  list.innerHTML = "";
  const evidence = Array.isArray(data.evidence) ? data.evidence : [];
  if (!evidence.length) {
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = "This model does not expose attention weights (evidence is available for the Bi-LSTM variants).";
    list.appendChild(note);
  } else {
    const maxWeight = evidence[0] ? evidence[0].weight : 1;
    evidence.forEach((e, i) => {
      const item = document.createElement("li");
      item.className = "evidence-item";
      item.style.setProperty("--d", Math.min(i * 45, 540) + "ms");
      const rel = maxWeight > 0 ? e.weight / maxWeight : 0;
      const pct = Math.max(3, rel * 100);
      item.innerHTML =
        `<span class="ev-token">${escapeHtml(e.token)}</span>` +
        `<span class="ev-bar"><i></i></span>` +
        `<span class="ev-weight">${e.weight.toFixed(4)}</span>`;
      // Attention weight drives both the bar and the token's visual weight
      // (emphasis capped at 500 per the editorial type system)
      item.querySelector(".ev-token").style.fontWeight = 400 + Math.round(rel * 100);
      const bar = item.querySelector(".ev-bar i");
      bar.style.transitionDelay = (120 + i * 45) + "ms";
      requestAnimationFrame(() => requestAnimationFrame(() => {
        bar.style.width = pct.toFixed(1) + "%";
      }));
      list.appendChild(item);
    });
  }

  wrap.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
}

// ---------------------------------------------------------------------------
// Related jobs ("jobs that match this resume") — revealed only after scoring.
// Backend: POST /api/related-jobs { resume_text, model, top_k }
// ---------------------------------------------------------------------------
const relatedCache = new Map(); // resumeHash -> jobs[]
let lastResumePreview = "";      // last scored resume text (for related-jobs retry)

async function fetchRelatedJobs({ resumeText, file, model, topK = 6 }) {
  const fd = new FormData();
  if (resumeText) fd.append("resume_text", resumeText);
  if (file) fd.append("resume_file", file);
  fd.append("model", model);
  fd.append("top_k", String(topK));
  const resp = await fetch("/api/related-jobs", { method: "POST", body: fd });
  const jobs = await resp.json();
  if (jobs && jobs.error) throw new Error(jobs.error);
  return Array.isArray(jobs) ? jobs : [];
}

async function loadRelatedJobs(resumeText) {
  const section = $("relatedJobs");
  const grid = $("relatedGrid");
  const skel = $("relatedSkeleton");
  const empty = $("relatedEmpty");
  const errEl = $("relatedError");
  if (!section || !resumeText || !resumeText.trim()) return;

  section.classList.remove("d-none");
  grid.innerHTML = "";
  empty.classList.add("d-none");
  errEl.classList.add("d-none");
  skel.classList.remove("d-none");

  const hash = hashText(resumeText.trim());
  let jobs = relatedCache.get(hash);
  const minSkeleton = delay(600); // skeleton phase must not flash

  try {
    if (!jobs) {
      jobs = await fetchRelatedJobs({ resumeText, model: currentModel(), topK: 6 });
      if (jobs.length) relatedCache.set(hash, jobs);
    }
    await minSkeleton;
    skel.classList.add("d-none");
    if (!jobs.length) {
      empty.classList.remove("d-none");
      return;
    }
    renderRelatedCards(jobs);
    section.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
  } catch (err) {
    await minSkeleton;
    skel.classList.add("d-none");
    $("relatedErrorMsg").textContent = "Could not load related jobs: " + err.message;
    errEl.classList.remove("d-none");
  }
}

// ---------------------------------------------------------------------------
// Match My Resume tab: paste resume -> search + score many jobs (viva flow)
// ---------------------------------------------------------------------------
function bindMatchTab() {
  const ta = $("matchResumeText");
  const input = $("matchResumeFile");
  const btn = $("matchBtn");
  if (!ta || !btn) return;

  const status = (msg) => { const el = $("matchStatus"); if (el) el.textContent = msg; };

  btn.addEventListener("click", async () => {
    const pasted = ta.value.trim();
    const file = input && input.files && input.files[0];
    if (!pasted && !file) {
      showToast("Paste a resume or upload a file first.", "error");
      return;
    }

    const section = $("matchResults");
    const grid = $("matchGrid");
    const skel = $("matchSkeleton");
    const empty = $("matchEmpty");
    const errEl = $("matchError");
    section.classList.remove("d-none");
    grid.innerHTML = "";
    empty.classList.add("d-none");
    errEl.classList.add("d-none");
    skel.classList.remove("d-none");
    status("Searching live postings and scoring…");
    btn.disabled = true;

    if (pasted) {
      Reader.open("Your resume", "Matching against live job postings");
      Reader.startCycling();
      Reader.typewriter(pasted.slice(0, 600), 55);
    }

    const minSkeleton = delay(600);
    try {
      const jobs = await fetchRelatedJobs({
        resumeText: pasted,
        file,
        model: currentModel(),
        topK: 8,
      });
      await minSkeleton;
      skel.classList.add("d-none");
      if (pasted) await Reader.finalize("", []);
      if (!jobs.length) {
        empty.classList.remove("d-none");
        status("No matching jobs found.");
      } else {
        renderRelatedCards(jobs, { gridId: "matchGrid", useJdSwitchesTab: true });
        status(`Matched ${jobs.length} job${jobs.length === 1 ? "" : "s"} with ${currentModelName()}.`);
        section.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
      }
    } catch (err) {
      await minSkeleton;
      skel.classList.add("d-none");
      if (pasted) Reader.close();
      const msg = $("matchErrorMsg");
      if (msg) msg.textContent = "Could not find matching jobs: " + err.message;
      errEl.classList.remove("d-none");
      status("");
    } finally {
      btn.disabled = false;
    }
  });

  const retry = $("matchRetry");
  if (retry) retry.addEventListener("click", () => btn.click());
}

bindMatchTab();
bindCounter("matchResumeText", "matchCounter");
bindDropzone("matchResumeFile", "matchDrop");
bindFileChip("matchResumeFile", "matchFileName", "matchFileRemove");

const PROVIDER_META = {
  indeed: { label: "Indeed", logo: "logos/indeed.svg" },
  techstreet: { label: "TechStreet", logo: "logos/techstreet.svg" },
  demo: { label: "Demo dataset", logo: "logos/demo.svg" },
};

function jobProviderChip(job) {
  const key = job.provider || (job.source === "demo" ? "demo" : "");
  const meta = PROVIDER_META[key];
  if (!meta) {
    return `<span class="job-source">${job.source === "live" ? "Live posting" : "Demo dataset"}</span>`;
  }
  if (key === "demo") {
    return `<span class="job-provider job-provider-demo" title="Curated demo dataset">
      <img class="job-provider-logo" src="${meta.logo}" alt="" loading="lazy">${meta.label}
    </span>`;
  }
  return `<span class="job-provider" title="Source: ${meta.label}">
    <img class="job-provider-logo" src="${meta.logo}" alt="${meta.label}" loading="lazy">
  </span>`;
}

function renderRelatedCards(jobs, opts = {}) {
  const grid = $(opts.gridId || "relatedGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const matchedSet = (job) => new Set((job.matched_skills || []).map((s) => s.toLowerCase()));

  jobs.forEach((job, i) => {
    const card = document.createElement("article");
    card.className = "job-card job-band-" + fitBand(job.score);
    card.setAttribute("role", "listitem");
    card.style.setProperty("--d", Math.min(90 + i * 70, 560) + "ms");

    const pct = Math.round(clamp01(job.score) * 100);
    const matched = matchedSet(job);
    const chips = (job.skills || []).map((s, j) => {
      const m = matched.has(String(s).toLowerCase());
      return `<span class="skill-chip${m ? " matched" : ""}"${m ? ` style="--d:${160 + j * 50}ms"` : ""}>${escapeHtml(s)}</span>`;
    }).join("");
    const salary = (job.salary_min || job.salary_max)
      ? [job.salary_currency, job.salary_min || "?", job.salary_max || "?"]
          .filter(Boolean).join(" ")
      : "";
    const viewBtn = job.link
      ? `<a class="btn-view-job" href="${escapeHtml(job.link)}" target="_blank" rel="noopener noreferrer">View posting</a>`
      : "";
    const snippet = (job.snippet || "").trim();
    const snippetHtml = snippet
      ? `<p class="job-snippet">${escapeHtml(snippet)}</p>`
      : "";
    const jdWords = (job.jd_text || "").trim().split(/\s+/).filter(Boolean).length;
    const useJdBtn = jdWords < 30
      ? `<button type="button" class="btn-use-jd" disabled title="Full description unavailable — open the posting">Use this JD</button>`
      : `<button type="button" class="btn-use-jd">Use this JD</button>`;

    card.innerHTML = `
      <div class="job-top">
        <div>
          <h3 class="job-title">${escapeHtml(job.title)}</h3>
          <p class="job-company">${escapeHtml(job.company)}</p>
          <span class="job-loc">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>
            ${escapeHtml(job.location)}
          </span>
          ${job.remote ? `<span class="job-remote">Remote</span>` : ""}
          ${salary ? `<span class="job-salary">${escapeHtml(salary)}</span>` : ""}
          ${jobProviderChip(job)}
        </div>
        <div class="job-match" aria-label="${pct}% match">
          <span class="match-pct">${pct}%</span>
          <span class="match-label">match</span>
        </div>
      </div>
      ${snippetHtml}
      <div class="job-skills">${chips}</div>
      <div class="job-actions">
        ${useJdBtn}
        ${viewBtn}
      </div>`;

    // "Use this JD" — copy the description into the JD textarea and re-score.
    const useJdButton = card.querySelector(".btn-use-jd");
    if (useJdButton && !useJdButton.disabled) useJdButton.addEventListener("click", () => {
      $("jdText").value = job.jd_text || "";
      updateCounters();
      if (opts.useJdSwitchesTab) switchView("score");
      $("jdText").focus();
      showToast(`Loaded "${job.title}" — re-scoring…`, "info");
      doScore();
    });

    grid.appendChild(card);
  });
}

$("relatedRetry").addEventListener("click", () => {
  const resumeText = $("resumeText").value.trim() || lastResumePreview;
  loadRelatedJobs(resumeText);
});

// ---------------------------------------------------------------------------
// Rank multiple resumes
// ---------------------------------------------------------------------------
let lastRankResults = [];
let rankSortDesc = true;

function renderRankRows(results, instant) {
  const tbody = $("rankTableBody");
  tbody.innerHTML = "";
  results.forEach((r, i) => {
    const tr = document.createElement("tr");
    if (!instant) tr.style.setProperty("--d", Math.min(i * 60, 420) + "ms");
    else tr.classList.add("flip");
    if (r.rank <= 3) tr.classList.add(`rank-${r.rank}`);
    const medal = r.rank <= 3
      ? `<span class="rank-medal">${r.rank}</span>`
      : `<span>${r.rank}</span>`;
    const pct = Math.round(clamp01(r.score) * 100);
    tr.innerHTML =
      `<td class="rank-num">${medal}</td>` +
      `<td class="file-cell">${escapeHtml(r.name)}</td>` +
      `<td class="score-cell">${r.score.toFixed(4)}<span class="mini-bar"><i></i></span></td>` +
      `<td><span class="badge ${r.label_cls || "badge-neutral"}">${escapeHtml(r.label)}</span></td>` +
      `<td>${r.suspicious_density ? '<span class="flag">Keyword-dense</span>' : ""}</td>`;
    tbody.appendChild(tr);
    const bar = tr.querySelector(".mini-bar i");
    bar.style.background = bandGradient(r.score);
    if (!instant) bar.style.setProperty("--d", (160 + i * 60) + "ms");
    else bar.style.transition = "none";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.width = pct + "%";
    }));
  });
}

function renderRankSkeleton() {
  const tbody = $("rankTableBody");
  tbody.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td class="rank-num"><span class="skl skl-w40"></span></td>' +
      '<td class="file-cell"><span class="skl skl-w60"></span></td>' +
      '<td class="score-cell"><span class="skl skl-w50"></span></td>' +
      '<td><span class="skl skl-w40"></span></td>' +
      '<td><span class="skl skl-w50"></span></td>';
    tbody.appendChild(tr);
  }
}

// FLIP-animated re-sort by fit score
$("sortScoreBtn").addEventListener("click", () => {
  if (!lastRankResults.length) return;
  rankSortDesc = !rankSortDesc;
  const rows = Array.from($("rankTableBody").querySelectorAll("tr"));
  const firstPos = new Map(rows.map((row) => [
    row.querySelector(".file-cell") ? row.querySelector(".file-cell").textContent : "",
    row.getBoundingClientRect().top,
  ]));

  const sorted = [...lastRankResults].sort((a, b) =>
    rankSortDesc ? b.score - a.score : a.score - b.score);
  sorted.forEach((r, i) => { r.rank = i + 1; });
  lastRankResults = sorted;
  $("sortScoreBtn").setAttribute("aria-sort", rankSortDesc ? "descending" : "ascending");

  renderRankRows(sorted, true);

  const newRows = Array.from($("rankTableBody").querySelectorAll("tr"));
  newRows.forEach((row) => {
    const name = row.querySelector(".file-cell").textContent;
    const oldTop = firstPos.get(name);
    if (oldTop === undefined) return;
    const delta = oldTop - row.getBoundingClientRect().top;
    if (Math.abs(delta) > 1) {
      row.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        row.style.transform = "translateY(0)";
      }));
    }
  });
});

$("rankBtn").addEventListener("click", async () => {
  const jd = $("rankJdText").value;
  const files = $("rankResumeFiles").files;
  if (!jd.trim() || files.length === 0) {
    showToast("Provide a job description and at least one resume.", "error");
    return;
  }
  const btn = $("rankBtn");
  const spinner = $("rankSpinner");
  const status = $("rankStatus");
  spinner.classList.remove("d-none");
  status.textContent = `Ranking ${files.length} resume${files.length === 1 ? "" : "s"}…`;
  setBusy(btn, true, "Ranking…");

  $("rankResult").classList.remove("d-none");
  renderRankSkeleton();
  $("sortScoreBtn").setAttribute("aria-sort", "descending");
  rankSortDesc = true;

  const fd = new FormData();
  fd.append("jd_text", jd);
  fd.append("model_name", currentModel());
  for (const f of files) fd.append("resume_files", f);

  try {
    const resp = await fetch("/rank", { method: "POST", body: fd });
    const data = await resp.json();
    if (data.error) {
      $("rankTableBody").innerHTML = "";
      showToast(data.error, "error");
      return;
    }
    lastRankResults = data.results || [];
    renderRankRows(lastRankResults, false);
    status.textContent = `Ranked ${lastRankResults.length} resume${lastRankResults.length === 1 ? "" : "s"} with ${currentModelName()}.`;
    $("rankResult").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
  } catch (err) {
    $("rankTableBody").innerHTML = "";
    showToast("Error: " + err.message);
  } finally {
    spinner.classList.add("d-none");
    setBusy(btn, false);
  }
});

// ---------------------------------------------------------------------------
// Export ranking results as CSV (FR-09)
// ---------------------------------------------------------------------------
$("exportBtn").addEventListener("click", async () => {
  const jd = $("rankJdText").value;
  const files = $("rankResumeFiles").files;
  if (!jd.trim() || files.length === 0) {
    showToast("Provide a job description and at least one resume.", "error");
    return;
  }
  const btn = $("exportBtn");
  setBusy(btn, true, "Exporting…");

  const fd = new FormData();
  fd.append("jd_text", jd);
  fd.append("model_name", currentModel());
  for (const f of files) fd.append("resume_files", f);

  try {
    const resp = await fetch("/export", { method: "POST", body: fd });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showToast(err.error || "Export failed.", "error");
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ranking_results.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    $("rankStatus").textContent = "Exported ranking_results.csv.";
  } catch (err) {
    showToast("Error: " + err.message);
  } finally {
    setBusy(btn, false);
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
const counterUpdaters = [];
function updateCounters() { counterUpdaters.forEach((u) => u()); }

(function init() {
  // Staggered page entrance (40-80ms rhythm)
  document.querySelectorAll(".rise").forEach((el, i) => {
    el.style.setProperty("--d", Math.min(40 + i * 60, 340) + "ms");
  });

  // Counters
  counterUpdaters.push(
    bindCounter("resumeText", "resumeCounter"),
    bindCounter("jdText", "jdCounter"),
  );

  // Drop zones + file chips
  bindDropzone("resumeFile", "resumeDrop");
  bindDropzone("jdFile", "jdDrop");
  bindDropzone("rankResumeFiles", "rankDrop");
  bindFileChip("resumeFile", "resumeFileName", "resumeFileRemove");
  bindFileChip("jdFile", "jdFileName", "jdFileRemove");
  $("rankResumeFiles").addEventListener("change", renderRankFiles);

  // Tab pill position (also after fonts/layout settle and on resize)
  positionTabPill();
  window.addEventListener("load", positionTabPill);
  window.addEventListener("resize", debounce(positionTabPill, 120));

  loadSamples();
})();
