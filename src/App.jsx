import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------- Persistence helpers ------------------------- */
const LS_KEY = "timetally_v2_cssmatch";
const SYNC_CH = "timetally_bc_sync"; // BroadcastChannel name for cross-tab sync

const defaultConfig = () => ({
  beepEnabled: true,
  ttsEnabled: false,
  selectedVoiceName: "",
  ttsMode: "taskNamePlusDurationStart",
  ttsCustomMessage: "Task completed!"
});

const defaultState = () => ({
  lists: { default: [] },
  listOrder: ["default"],
  currentList: "default",
  currentTaskIndex: 0,
  listConfigs: { default: defaultConfig() },
  dark: true,
  showHelp: false,
  showOptions: false,
  isListCreating: false
});

function isYouTubeUrl(value = "") {
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^www\./, "");
    return (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be" ||
      host.endsWith(".youtube.com")
    );
  } catch {
    return false;
  }
}

function parseYouTubeId(value = "") {
  // Supports youtu.be/{id}, youtube.com/watch?v=, youtube.com/shorts/, /embed/
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1) || null; // /{id}
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "shorts" && parts[1]) return parts[1];
    if (parts[0] === "embed" && parts[1]) return parts[1];
    return null;
  } catch {
    return null;
  }
}

function normalizeTaskFromName(rawName, timeSeconds) {
  // Normalize a task; attach YT meta if the "name" is a YouTube URL
  const name = String(rawName || "").trim();
  if (isYouTubeUrl(name)) {
    const ytId = parseYouTubeId(name);
    return { name, time: timeSeconds, remaining: timeSeconds, enabled: true, editing: false, meta: { ytUrl: name, ytId } };
  }
  return { name, time: timeSeconds, remaining: timeSeconds, enabled: true, editing: false };
}

/* Migration to ensure previously-saved or imported tasks infer YT meta
   so embeds appear without manual edits. */
function migrateYouTubeMeta(state) {
  const next = structuredClone(state);
  let changed = false;
  for (const listName of Object.keys(next.lists || {})) {
    const arr = next.lists[listName] || [];
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i];
      // If no meta.ytId but the name is a YT URL, infer meta
      if ((!t.meta || !t.meta.ytId) && isYouTubeUrl(t.name)) {
        const ytId = parseYouTubeId(t.name);
        if (ytId) {
          arr[i] = { ...t, meta: { ...(t.meta || {}), ytId, ytUrl: t.name } }; // keep remaining as-is
          changed = true;
        }
      }
    }
  }
  return changed ? next : state;
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const merged = {
      ...defaultState(),
      ...parsed,
      listConfigs: { default: defaultConfig(), ...(parsed?.listConfigs || {}) }
    };
    // Run migration so any old data with YT URLs but no meta still embeds
    return migrateYouTubeMeta(merged);
  } catch {
    return defaultState();
  }
}

let saveTimer = null;
function saveState(state) {
  // Debounced save to reduce churn during ticking, while staying responsive
  const doSave = () => {
    const slim = JSON.stringify({
      lists: state.lists,
      listOrder: state.listOrder,
      currentList: state.currentList,
      currentTaskIndex: state.currentTaskIndex,
      listConfigs: state.listConfigs,
      dark: state.dark,
      showHelp: state.showHelp,
      showOptions: state.showOptions,
      isListCreating: state.isListCreating
    });
    localStorage.setItem(LS_KEY, slim); // write-through to storage for tab reloads
  };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 150); // small debounce window
}

/* ----------------------------- Utilities ------------------------------ */
const affirmations = ["Great job!", "Well done!", "You did it!", "Keep it up!", "Nice work!"];
const secs = (n) => n;
const mins = (n) => n * 60;
const hours = (n) => n * 3600;

function formatHMS(total) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/* TTS-friendly duration: “1 hour 5 minutes 3 seconds” */
function ttsDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const parts = [];
  if (h) parts.push(`${h} ${h === 1 ? "hour" : "hours"}`);
  if (m) parts.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
  if (r || (!h && !m)) parts.push(`${r} ${r === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}

function sumEnabledRemaining(tasks) {
  return tasks.reduce((acc, t) => acc + (t.enabled ? t.remaining : 0), 0);
}

/* ----------------------------- YouTube embed helpers ------------------------------ */
function ytIframeSrc(id) {
  // enablejsapi=1 allows control via postMessage; modest branding; no related; playsinline
  return `https://www.youtube.com/embed/${id}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1`;
}

function postToYouTubeIframe(iframe, func) {
  // Uses player API via postMessage without loading extra JS
  try {
    iframe?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args: [] }),
      "*"
    );
  } catch {
    /* ignore */
  }
}

/* ----------------------------- Main App ------------------------------ */
export default function App() {
  const [state, setState] = useState(loadState);
  const [voices, setVoices] = useState([]);
  const [menuOpenTask, setMenuOpenTask] = useState(null);   // index of open task menu
  const [menuOpenTab, setMenuOpenTab] = useState(null);     // name of list with open tab menu
  const timerRef = useRef(null);
  const audioRef = useRef(null);
  const lastTick = useRef(null);
  const draggedTabIndex = useRef(null);
  const bcRef = useRef(null);                               // BroadcastChannel ref

  // task DnD (pointer-based for mobile + desktop)
  const listRef = useRef(null);
  const draggingTask = useRef(null);
  const pointerActive = useRef(false);

  /* Theme sync */
  useEffect(() => {
    document.documentElement.classList.toggle("dark-mode", !!state.dark);
    document.body.classList.toggle("dark-mode", !!state.dark);
  }, [state.dark]);

  /* Persist (debounced) + cross-tab broadcast */
  useEffect(() => {
    saveState(state); // debounced localStorage persistence
    try {
      bcRef.current?.postMessage({ type: "STATE_PATCHED" }); // lightweight nudge; other tabs reload from LS
    } catch { /* ignore */ }
  }, [state]);

  /* Before unload: final flush */
  useEffect(() => {
    const handler = () => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state]);

  /* Cross-tab synchronization: storage + BroadcastChannel */
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === LS_KEY && e.newValue) {
        try {
          const incoming = JSON.parse(e.newValue);
          setState((curr) => migrateYouTubeMeta({
            ...curr,
            lists: incoming.lists ?? curr.lists,
            listOrder: incoming.listOrder ?? curr.listOrder,
            currentList: incoming.currentList ?? curr.currentList,
            currentTaskIndex: incoming.currentTaskIndex ?? curr.currentTaskIndex,
            listConfigs: incoming.listConfigs ?? curr.listConfigs,
            dark: incoming.dark ?? curr.dark
          }));
        } catch { /* ignore */ }
      }
    };
    window.addEventListener("storage", onStorage);

    try {
      bcRef.current = new BroadcastChannel(SYNC_CH);
      bcRef.current.onmessage = (msg) => {
        if (msg?.data?.type === "STATE_PATCHED") {
          const next = loadState();
          setState((_) => next);
        }
      };
    } catch { /* unsupported */ }

    return () => {
      window.removeEventListener("storage", onStorage);
      try { bcRef.current?.close?.(); } catch { /* ignore */ }
    };
  }, []);

  /* Beep */
  useEffect(() => {
    const a = new Audio("https://www.soundjay.com/buttons/beep-07a.mp3");
    a.preload = "auto";
    audioRef.current = a;
  }, []);

  /* Voices */
  useEffect(() => {
    const loadVoices = () => setVoices(window.speechSynthesis?.getVoices?.() || []);
    loadVoices();
    if (window.speechSynthesis?.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  /* Close menus on outside click/tap */
  useEffect(() => {
    function handleDown(e) {
      const inMenu = e.target.closest?.('[data-menu-root="true"]');
      const inBtn  = e.target.closest?.('[data-menu-button="true"]');
      if (!inMenu && !inBtn) { setMenuOpenTask(null); setMenuOpenTab(null); }
    }
    document.addEventListener("mousedown", handleDown, true);
    document.addEventListener("touchstart", handleDown, true);
    return () => {
      document.removeEventListener("mousedown", handleDown, true);
      document.removeEventListener("touchstart", handleDown, true);
    };
  }, []);

  /* Derived */
  const tasks = useMemo(() => state.lists[state.currentList] || [], [state]);
  const config = useMemo(() => state.listConfigs[state.currentList] || defaultConfig(), [state]);

  const progress = useMemo(() => {
    const total = tasks.reduce((a, t) => a + (t.time || 0), 0);
    const done = tasks.reduce((a, t) => a + (t.time - t.remaining), 0);
    return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }, [tasks]);

  const etaText = useMemo(() => {
    const secsLeft = sumEnabledRemaining(tasks);
    if (secsLeft <= 0) return "";
    const finish = new Date(Date.now() + secsLeft * 1000);
    const hh = String(finish.getHours()).padStart(2, "0");
    const mm = String(finish.getMinutes()).padStart(2, "0");
    return `ETA: ${hh}:${mm} · ${formatHMS(secsLeft)} remaining`;
  }, [tasks]);

  /* State helpers */
  const patch = (fn) => setState((s) => {
    const next = structuredClone(s);
    fn(next);
    return migrateYouTubeMeta(next); // keep meta consistent whenever we patch
  });

  function ensureListConfig(name) {
    if (!state.listConfigs[name]) {
      patch((n) => { n.listConfigs[name] = defaultConfig(); });
    }
  }

  /* Tabs */
  function setCurrentList(name) {
    ensureListConfig(name);
    patch((n) => { n.currentList = name; n.currentTaskIndex = 0; });
  }

  function addList(name) {
    if (!name || state.lists[name]) return;
    patch((n) => {
      n.lists[name] = [];
      n.listOrder.push(name);
      n.listConfigs[name] = defaultConfig();
      n.currentList = name;
      n.currentTaskIndex = 0;
      n.isListCreating = false;
    });
  }

  function renameList(oldName, newName) {
    if (!newName || oldName === newName || state.lists[newName]) return;
    patch((n) => {
      n.lists[newName] = n.lists[oldName];
      delete n.lists[oldName];
      n.listConfigs[newName] = n.listConfigs[oldName];
      delete n.listConfigs[oldName];
      n.listOrder = n.listOrder.map((x) => (x === oldName ? newName : x));
      if (n.currentList === oldName) n.currentList = newName;
    });
  }

  function deleteList(name) {
    if (state.listOrder.length <= 1) return;
    patch((n) => {
      delete n.lists[name];
      delete n.listConfigs[name];
      n.listOrder = n.listOrder.filter((x) => x !== name);
      if (n.currentList === name) n.currentList = n.listOrder[0];
      n.currentTaskIndex = 0;
    });
  }

  function reorderList(oldIdx, newIdx) {
    patch((n) => {
      const arr = n.listOrder;
      const [item] = arr.splice(oldIdx, 1);
      arr.splice(newIdx, 0, item);
    });
  }

  /* Tasks */
  function addTaskUI() {
    const name = document.getElementById("taskName").value.trim();
    const amt = Number(document.getElementById("taskTime").value);
    const unit = document.getElementById("timeUnit").value;
    if (!name || !amt || amt <= 0) return;
    const toSeconds = unit === "seconds" ? secs : unit === "minutes" ? mins : hours;
    const t = toSeconds(amt);
    patch((n) => {
      const listTasks = n.lists[n.currentList];
      // Normalize so YT URL inputs get meta immediately
      const norm = normalizeTaskFromName(name, t);
      listTasks.push(norm);
    });
    document.getElementById("taskName").value = "";
    document.getElementById("taskTime").value = "";
  }

  function removeTask(i) {
    patch((n) => {
      n.lists[n.currentList].splice(i, 1);
      if (n.currentTaskIndex >= n.lists[n.currentList].length) n.currentTaskIndex = 0;
    });
  }

  function editTask(i, patchFields) {
    patch((n) => {
      const t = n.lists[n.currentList][i];
      // If name changes, re-normalize possible YT metadata
      let next = { ...t, ...patchFields };
      if (patchFields.name !== undefined) {
        const norm = normalizeTaskFromName(String(patchFields.name), next.time ?? t.time);
        next = { ...next, ...norm, remaining: (patchFields.remaining ?? norm.remaining) };
      }
      const nextTime = patchFields.time ?? t.time;
      const timeChanged = nextTime !== t.time;
      n.lists[n.currentList][i] = {
        ...next,
        time: nextTime,
        remaining: timeChanged ? nextTime : (patchFields.remaining ?? next.remaining)
      };
    });
  }

  /* Task DnD (pointer, mobile + desktop) */
  function indexFromPoint(clientY) {
    const ul = listRef.current;
    if (!ul) return null;
    const children = Array.from(ul.children);
    let targetIndex = children.length - 1;
    for (let idx = 0; idx < children.length; idx++) {
      const rect = children[idx].getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (clientY < mid) { targetIndex = idx; break; }
    }
    return targetIndex;
  }

  function reorderTask(from, to) {
    if (from === to || from == null || to == null) return;
    patch((n) => {
      const arr = n.lists[n.currentList];
      if (!arr || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return;
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item);
      if (n.currentTaskIndex === from) n.currentTaskIndex = to;
      else if (from < n.currentTaskIndex && to >= n.currentTaskIndex) n.currentTaskIndex -= 1;
      else if (from > n.currentTaskIndex && to <= n.currentTaskIndex) n.currentTaskIndex += 1;
    });
  }

  function onTaskPointerDown(i, e) {
    // ignore drags starting on interactive elements to keep clicks working on desktop
    if (
      e.target.closest('[data-menu-button="true"]') ||
      e.target.closest('[data-menu-root="true"]') ||
      e.target.closest(".enable-checkbox-wrapper") ||
      e.target.closest("button") ||
      e.target.closest("a") ||
      e.target.closest("input") ||
      e.target.closest("select") ||
      e.target.closest("label")
    ) {
      return;
    }
    pointerActive.current = true;
    draggingTask.current = i;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.body.style.touchAction = "none"; // prevent scroll during drag on mobile
  }

  function onTaskPointerMove(e) {
    if (!pointerActive.current) return;
    const from = draggingTask.current;
    const to = indexFromPoint(e.clientY);
    if (from == null || to == null) return;
    if (from !== to) {
      reorderTask(from, to);
      draggingTask.current = to;
    }
  }

  function onTaskPointerUp() {
    if (!pointerActive.current) return;
    pointerActive.current = false;
    draggingTask.current = null;
    document.body.style.touchAction = "";
  }

  /* Timer + TTS */
  function speak(text) {
    if (!config.ttsEnabled || !text) return;
    const utter = new SpeechSynthesisUtterance(text);
    const v = voices.find((x) => x.name === config.selectedVoiceName);
    if (v) utter.voice = v;
    window.speechSynthesis.speak(utter);
  }

  function beep() {
    if (!config.beepEnabled) return;
    audioRef.current?.play?.();
  }

  function nextEnabledIndex(start) {
    const arr = state.lists[state.currentList] || [];
    for (let k = start; k < arr.length; k++) if (arr[k].enabled) return k;
    return -1;
  }

  function taskTitleForTTS(task) {
    // Do not read the URL; prefer a generic label if no better title is available
    if (isYouTubeUrl(task.name)) return "YouTube video";
    return task.name;
  }

  function pauseAllYouTube() {
    // Pause all embedded players via postMessage
    try {
      const iframes = document.querySelectorAll('iframe[data-yt-frame="1"]');
      iframes.forEach((f) => postToYouTubeIframe(f, "pauseVideo"));
    } catch { /* ignore */ }
  }

  function playYouTubeIfAny(idx) {
    // Autoplay the current task's video if the task has a YT ID (works for imported & newly added)
    const key = `${state.currentList}__${idx}`;
    const iframe = document.getElementById(`yt-iframe-${key}`);
    if (!iframe) return;
    postToYouTubeIframe(iframe, "playVideo"); // request playback
  }

  function announceStart(task) {
    const dur = ttsDuration(task.remaining);
    const title = taskTitleForTTS(task);
    if (config.ttsMode === "taskNamePlusDurationStart") speak(`Starting ${title} for ${dur}`);
    else if (config.ttsMode === "taskNameStart") speak(`Starting ${title}`);
    else if (config.ttsMode === "durationStart") speak(`Starting ${dur}`);
  }

  function announceComplete() {
    if (config.ttsMode === "customCompletion") speak(config.ttsCustomMessage || "Task completed");
    else if (config.ttsMode === "randomAffirmation") speak(affirmations[Math.floor(Math.random() * affirmations.length)]);
  }

  function startTimer() {
    if (timerRef.current) return;
    const startIndex = nextEnabledIndex(state.currentTaskIndex);
    if (startIndex === -1) return;
    patch((n) => { n.currentTaskIndex = startIndex; });
    const current = (state.lists[state.currentList] || [])[startIndex];
    announceStart(current);
    pauseAllYouTube();           // ensure only the current video plays
    playYouTubeIfAny(startIndex); // autoplay YT when starting the task
    lastTick.current = performance.now();

    timerRef.current = setInterval(() => {
      const now = performance.now();
      const dt = (now - (lastTick.current || now)) / 1000;
      lastTick.current = now;

      patch((n) => {
        const arr = n.lists[n.currentList];
        const idx = n.currentTaskIndex;
        const t = arr[idx];
        if (!t) return;
        t.remaining = Math.max(0, t.remaining - dt);
        if (t.remaining <= 0) {
          announceComplete();
          beep();
          const nxt = nextEnabledIndex(idx + 1);
          if (nxt === -1) {
            clearInterval(timerRef.current);
            timerRef.current = null;
            pauseAllYouTube();           // stop any video when series ends
            arr.forEach((x) => (x.remaining = x.time));
            n.currentTaskIndex = 0;
          } else {
            n.currentTaskIndex = nxt;
            announceStart(arr[nxt]);
            pauseAllYouTube();
            playYouTubeIfAny(nxt);      // autoplay next video's task if any
          }
        }
      });
    }, 200);
  }

  function pauseTimer() {
    if (!timerRef.current) return;
    clearInterval(timerRef.current);
    timerRef.current = null;
    pauseAllYouTube(); // pause any YT playback when pausing timer
  }

  function skipTask() {
    // Move to the next task but leave the current task's remaining time unchanged
    const nxt = nextEnabledIndex(state.currentTaskIndex + 1);
    if (nxt === -1) return;
    const wasRunning = !!timerRef.current;
    pauseAllYouTube(); // stop any current playback
    if (wasRunning) {
      lastTick.current = performance.now(); // avoid time jump
      patch((n) => { n.currentTaskIndex = nxt; });
      playYouTubeIfAny(nxt); // autoplay next if video
    } else {
      patch((n) => { n.currentTaskIndex = nxt; });
    }
  }

  function completeEarly() {
    pauseTimer();
    patch((n) => {
      const arr = n.lists[n.currentList];
      const t = arr[n.currentTaskIndex];
      if (t) t.remaining = 0;
    });
    startTimer();
  }

  function restartTimer() {
    pauseTimer();
    patch((n) => {
      (n.lists[n.currentList] || []).forEach((t) => { t.remaining = t.time; });
      n.currentTaskIndex = 0;
    });
  }

  /* Import / Export */
  function exportTasksToXML() {
    const doc = document.implementation.createDocument("", "", null);
    const root = doc.createElement("timetally");
    for (const listName of state.listOrder) {
      const listEl = doc.createElement("list");
      listEl.setAttribute("name", listName);
      const ts = state.lists[listName] || [];
      ts.forEach((t) => {
        const el = doc.createElement("task");
        el.setAttribute("name", t.name);
        el.setAttribute("time", String(t.time));
        el.setAttribute("remaining", String(Math.round(t.remaining)));
        el.setAttribute("enabled", t.enabled ? "1" : "0");
        if (t.meta?.ytId) {
          el.setAttribute("ytId", t.meta.ytId);
          el.setAttribute("ytUrl", t.meta.ytUrl || "");
        }
        listEl.appendChild(el);
      });
      root.appendChild(listEl);
    }
    doc.appendChild(root);
    const xml = new XMLSerializer().serializeToString(doc);
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: "timetally_tasks.xml" });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  function onFileLoaded(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const doc = new DOMParser().parseFromString(text, "application/xml");
        const listNodes = [...doc.querySelectorAll("list")];
        if (!listNodes.length) return;
        patch((n) => {
          listNodes.forEach((ln) => {
            const name = ln.getAttribute("name") || "imported";
            if (!n.lists[name]) { n.lists[name] = []; n.listOrder.push(name); }
            const tasks = [...ln.querySelectorAll("task")].map((el) => {
              const time = Number(el.getAttribute("time") || 0);
              const rem = Number(el.getAttribute("remaining") || 0) || time;
              const importedName = el.getAttribute("name") || "Task";
              // Start from normalization so YouTube URLs immediately get meta
              const norm = normalizeTaskFromName(importedName, time);
              // Respect explicit attributes if present (back-compat)
              const ytIdAttr = el.getAttribute("ytId");
              const ytUrlAttr = el.getAttribute("ytUrl");
              const meta = ytIdAttr
                ? { ytId: ytIdAttr, ytUrl: ytUrlAttr || (isYouTubeUrl(importedName) ? importedName : "") }
                : norm.meta;
              return {
                ...norm,
                remaining: rem,                  // keep imported remaining value
                enabled: (el.getAttribute("enabled") || "1") === "1",
                editing: false,
                meta
              };
            });
            n.lists[name].push(...tasks);
            if (!n.listConfigs[name]) n.listConfigs[name] = defaultConfig();
          });
        });
      } catch { /* ignore */ }
      e.target.value = "";
    };
    reader.readAsText(file);
  }

  /* Render */
  const containerClasses = `container${state.dark ? " dark-mode" : ""}`;

  return (
    <div className={containerClasses}>
      <header>
        <h1>TimeTally</h1>
        <div className="header-buttons">
          <button
            id="toggleOptionsButton"
            className="gear-button"
            title="Toggle Settings"
            onClick={() => { setMenuOpenTask(null); setMenuOpenTab(null); patch((n) => { n.showOptions = !n.showOptions; }); }}
          >
            <i className="fas fa-cog" />
          </button>
          <button
            id="toggleHelpButton"
            className="help-button"
            title="Help"
            onClick={() => { setMenuOpenTask(null); setMenuOpenTab(null); patch((n) => { n.showHelp = !n.showHelp; }); }}
          >
            <i className="fas fa-question-circle" />
          </button>
          <button
            id="toggleDarkModeButton"
            className="dark-mode-button"
            title="Toggle Dark Mode"
            onClick={() => patch((n) => { n.dark = !n.dark; })}
          >
            <i className="fas fa-moon" />
          </button>
        </div>
      </header>

      <div
        id="helpMenu"
        className={`help-menu${state.dark ? " dark-mode" : ""}`}
        style={{ display: state.showHelp ? "block" : "none" }}
      >
        <h3>How to Use TimeTally</h3>
        <p>Manage time-tracking tasks with multiple lists.</p>
        <ul>
          <li><b>Tasks:</b> Add, edit, remove, enable/disable, drag to reorder.</li>
          <li><b>Per-List Options:</b> Beep, TTS, voice, and mode.</li>
          <li><b>TTS:</b> Durations speak with spelled-out units for clarity.</li>
          <li><b>Persistence:</b> All lists and progress are saved automatically and synchronized across tabs.</li>
        </ul>
      </div>

      {/* Tabs */}
      <div id="tabsContainer" className="tabs-container">
        {state.listOrder.map((name, idx) => {
          const active = name === state.currentList;
          const cls = `tab${active ? " active" : ""}${state.dark ? " dark-mode" : ""}`;
          return (
            <div
              key={name}
              className={cls}
              style={{ position: "relative" }}
              draggable
              data-list-name={name}
              onDragStart={(e) => { draggedTabIndex.current = idx; e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = draggedTabIndex.current;
                if (from === null) return;
                reorderList(from, idx);
                draggedTabIndex.current = null;
              }}
              onDragEnd={() => { draggedTabIndex.current = null; }}
              onClick={(e) => {
                if (e.target.closest('[data-menu-button="true"]') || e.target.closest('[data-menu-root="true"]')) return;
                setCurrentList(name);
              }}
              title={name}
            >
              <span className="tab-name">{name}</span>

              <button
                className="icon-button ellipsis-button"
                title="List actions"
                data-menu-button="true"
                onClick={(e) => { e.stopPropagation(); setMenuOpenTab(menuOpenTab === name ? null : name); }}
              >
                <i className="fa fa-ellipsis-h" />
              </button>

              {menuOpenTab === name && (
                <div
                  data-menu-root="true"
                  className={`menu-popover${state.dark ? " dark-mode" : ""}`}
                  style={{ right: 0, top: "calc(100% + 6px)" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="menu-item"
                    onClick={() => {
                      const nn = prompt("Rename list", name);
                      if (nn && nn.trim()) renameList(name, nn.trim());
                      setMenuOpenTab(null);
                    }}
                  >
                    <i className="fas fa-pen" /> Rename
                  </button>
                  <button
                    className="menu-item menu-danger"
                    onClick={() => { deleteList(name); setMenuOpenTab(null); }}
                  >
                    <i className="fas fa-trash" /> Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
        <button
          className="tab-add-btn"
          title="Create a New List"
          onClick={() => { setMenuOpenTab(null); patch((n) => { n.isListCreating = true; }); }}
        >
          <i className="fas fa-plus" /> New List
        </button>
      </div>

      {/* Create list fields */}
      <div id="listCreateFields" style={{ display: state.isListCreating ? "flex" : "none" }}>
        <input type="text" id="createListName" placeholder="New list name" />
        <button onClick={() => {
          const val = document.getElementById("createListName").value.trim();
          if (val) addList(val);
          document.getElementById("createListName").value = "";
        }}>
          <i className="fas fa-save" />
        </button>
        <button className="btn-cancel" onClick={() => patch((n) => { n.isListCreating = false; })}>
          <i className="fas fa-times" />
        </button>
      </div>

      {/* Options */}
      <div
        id="optionsMenu"
        className={`options-menu${state.dark ? " dark-mode" : ""}`}
        style={{ display: state.showOptions ? "block" : "none" }}
      >
        <h3>List Options</h3>

        <div className={`option-row${state.dark ? " dark-mode" : ""}`}>
          <label>Enable Beep?</label>
          <div className="enable-checkbox-wrapper">
            <input
              type="checkbox"
              id="beepCheckbox"
              className="enable-checkbox"
              checked={!!config.beepEnabled}
              onChange={(e) => patch((n) => { n.listConfigs[n.currentList].beepEnabled = e.target.checked; })}
            />
            <label className="enable-checkbox-label" htmlFor="beepCheckbox"></label>
          </div>
        </div>

        <div className={`option-row${state.dark ? " dark-mode" : ""}`}>
          <label>Enable TTS?</label>
          <div className="enable-checkbox-wrapper">
            <input
              type="checkbox"
              id="ttsCheckbox"
              className="enable-checkbox"
              checked={!!config.ttsEnabled}
              onChange={(e) => patch((n) => { n.listConfigs[n.currentList].ttsEnabled = e.target.checked; })}
            />
            <label className="enable-checkbox-label" htmlFor="ttsCheckbox"></label>
          </div>
        </div>

        <div className="option-row">
          <label htmlFor="voiceSelect">Voice:</label>
          <select
            id="voiceSelect"
            value={config.selectedVoiceName || (voices[0]?.name || "")}
            onChange={(e) => patch((n) => { n.listConfigs[n.currentList].selectedVoiceName = e.target.value; })}
          >
            {voices.map((v) => <option key={v.name} value={v.name}>{v.name}{v.default ? " (default)" : ""}</option>)}
          </select>
        </div>

        <div className="option-row">
          <label htmlFor="ttsModeSelect">TTS Says:</label>
          <select
            id="ttsModeSelect"
            value={config.ttsMode}
            onChange={(e) => patch((n) => { n.listConfigs[n.currentList].ttsMode = e.target.value; })}
          >
            <option value="taskNamePlusDurationStart">Start: Task name + duration</option>
            <option value="taskNameStart">Start: Task name only</option>
            <option value="durationStart">Start: Duration only</option>
            <option value="customCompletion">Completion: Custom message</option>
            <option value="randomAffirmation">Completion: Random affirmation</option>
          </select>
        </div>

        <div
          className="option-row"
          id="customMessageRow"
          style={{ display: config.ttsMode === "customCompletion" ? "flex" : "none" }}
        >
          <label htmlFor="ttsCustomMessage">Custom Message:</label>
          <input
            type="text"
            id="ttsCustomMessage"
            placeholder="e.g. Task completed!"
            value={config.ttsCustomMessage}
            onChange={(e) => patch((n) => { n.listConfigs[n.currentList].ttsCustomMessage = e.target.value; })}
          />
        </div>
      </div>

      {/* ETA */}
      <div className={`section-box${state.dark ? " dark-mode" : ""}`}>
        <div className={`estimated-finish${state.dark ? " dark-mode" : ""}`} id="estimatedFinishTime">
          {etaText}
        </div>
      </div>

      {/* Task input */}
      <div className={`section-box${state.dark ? " dark-mode" : ""}`}>
        <div className={`task-input${state.dark ? " dark-mode" : ""}`}>
          <input type="text" id="taskName" placeholder="Task Name or YouTube URL" />
          <input type="number" id="taskTime" placeholder="Time" />
          <select id="timeUnit" aria-label="Time Unit" defaultValue="minutes">
            <option value="seconds">Seconds</option>
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
          </select>
          <button onClick={addTaskUI} title="Add Task">
            <i className="fas fa-plus" />
          </button>
        </div>
      </div>

      {/* Task list */}
      <ul id="taskList" ref={listRef}>
        {tasks.map((t, i) => {
          const isCurrent = i === state.currentTaskIndex;
          const itemCls = `task-item${state.dark ? " dark-mode" : ""}`;
          // Robust: compute ytId from meta first, otherwise from the name if it is a URL
          const ytId = t?.meta?.ytId || (isYouTubeUrl(t.name) ? parseYouTubeId(t.name) : null);
          const key = `${state.currentList}__${i}`;
          return (
            <li
              key={i}
              className={itemCls}
              style={{ touchAction: "none", position: "relative" }}
              onPointerDown={(e) => onTaskPointerDown(i, e)}
              onPointerMove={onTaskPointerMove}
              onPointerUp={onTaskPointerUp}
              onPointerCancel={onTaskPointerUp}
              onClick={(e) => {
                if (e.target.closest(".task-actions")) return;
                setMenuOpenTask(null);
                patch((n) => { n.currentTaskIndex = i; });
              }}
            >
              <div className="task-details">
                <div className="task-name">
                  {isCurrent ? "[Current] " : ""}
                  {isYouTubeUrl(t.name) ? "YouTube video" : t.name}
                </div>
                <div className="task-time">({formatHMS(t.remaining)} remaining)</div>

                {/* Embedded YouTube player */}
                {ytId && (
                  <div className="yt-embed-wrapper">
                    <iframe
                      id={`yt-iframe-${key}`}
                      data-yt-frame="1"
                      src={ytIframeSrc(ytId)}
                      title="YouTube video"
                      style={{ width: "100%", aspectRatio: "16 / 9", border: 0, pointerEvents: isCurrent ? "auto" : "none", opacity: isCurrent ? 1 : 0.9 }}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                    />
                    {!isCurrent && <div className="yt-embed-hint">Select task to control playback</div>}
                  </div>
                )}
              </div>

              <div className="task-actions">
                <div className="enable-checkbox-wrapper" title="Enable/disable this task">
                  <input
                    type="checkbox"
                    id={`taskEnabledCheckbox${i}`}
                    className="enable-checkbox"
                    checked={t.enabled}
                    onChange={(e) => editTask(i, { enabled: e.target.checked })}
                  />
                  <label className="enable-checkbox-label" htmlFor={`taskEnabledCheckbox${i}`}></label>
                </div>

                <button
                  className="icon-button ellipsis-button"
                  title="More actions"
                  data-menu-button="true"
                  onClick={(e) => { e.stopPropagation(); setMenuOpenTask(menuOpenTask === i ? null : i); }}
                >
                  <i className="fa fa-ellipsis-h" />
                </button>

                {menuOpenTask === i && (
                  <div
                    data-menu-root="true"
                    className={`menu-popover${state.dark ? " dark-mode" : ""}`}
                    style={{ right: 0, top: "calc(100% + 6px)" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      className="menu-item"
                      onClick={() => { editTask(i, { editing: true }); setMenuOpenTask(null); }}
                    >
                      <i className="fas fa-pen" /> Edit
                    </button>
                    <button
                      className="menu-item menu-danger"
                      onClick={() => { removeTask(i); setMenuOpenTask(null); }}
                    >
                      <i className="fas fa-trash" /> Delete
                    </button>
                  </div>
                )}

                {t.editing && (
                  <>
                    <button
                      title="Save"
                      onClick={(e) => {
                        e.stopPropagation();
                        const nn = prompt("Task name (or YouTube URL)", t.name) ?? t.name;
                        const nt = Number(prompt("Seconds (total time)", String(t.time)) ?? t.time);
                        if (nn.trim() && nt > 0) editTask(i, { name: nn.trim(), time: nt });
                        editTask(i, { editing: false });
                        setMenuOpenTask(null);
                      }}
                    >
                      <i className="fas fa-save" />
                    </button>
                    <button
                      className="btn-cancel"
                      title="Cancel"
                      onClick={(e) => { e.stopPropagation(); editTask(i, { editing: false }); setMenuOpenTask(null); }}
                    >
                      <i className="fas fa-times" />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Timer */}
      <div className={`timer-section${state.dark ? " dark-mode" : ""}`}>
        <div className={`progress-container${state.dark ? " dark-mode" : ""}`}>
          <div className={`progress-bar${state.dark ? " dark-mode" : ""}`} style={{ width: `${progress}%` }} />
        </div>
        <div className={`timer-info${state.dark ? " dark-mode" : ""}`}>
          <div id="timerText" className="timer-text">Progress</div>
          <div id="timerPercent" className="timer-percent">{progress}%</div>
        </div>
      </div>

      {/* Controls */}
      <div className="controls">
        <button className="btn-start" onClick={startTimer} title="Start Timer"><i className="fas fa-play" /> Start</button>
        <button className="btn-skip" onClick={skipTask} title="Skip Current Task"><i className="fas fa-forward" /> Skip</button>
        <button className="btn-complete" onClick={completeEarly} title="Complete Early"><i className="fas fa-check" /> Complete</button>
        <button className="btn-pause" onClick={pauseTimer} title="Pause Timer"><i className="fas fa-pause" /> Pause</button>
        <button className="btn-red" onClick={restartTimer} title="Restart All Tasks"><i className="fas fa-undo-alt" /> Restart</button>
      </div>

      {/* Import / Export */}
      <div className="import-export">
        <div className="export-section">
          <button className="btn-export" onClick={exportTasksToXML} title="Export Tasks">
            <i className="fas fa-file-export" /> Export Tasks
          </button>
        </div>
        <div className="import-section" id="importSection">
          <button id="importFileBttn" onClick={() => document.getElementById("importFile").click()}>
            <i className="fas fa-file-import"></i> Import Tasks
          </button>
          <input
            type="file"
            id="importFile"
            accept=".xml"
            onChange={onFileLoaded}
            style={{ display: "none" }}
          />
        </div>
      </div>
    </div>
  );
}
