import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------- Persistence helpers ------------------------- */
const LS_KEY = "timetally_v2_cssmatch";
const SYNC_CH = "timetally_bc_sync"; // BroadcastChannel name for cross-tab sync

const defaultConfig = () => ({
  // Audio
  beepEnabled: true,
  beepVolume: 0.3,
  beepTone: "medium",          // "low" | "medium" | "high"
  beepCount: 1,                // 1 | 2 | 3
  // TTS
  ttsEnabled: false,
  selectedVoiceName: "",
  ttsMode: "taskNamePlusDurationStart",
  ttsCustomMessage: "Task completed!",
  // Timer behaviour
  autoAdvance: true,
  timerDirection: "countdown", // "countdown" | "countup"
  warningThreshold: 0,         // seconds; 0 = disabled
  // Progress / footer display
  progressBarMode: "list",     // "list" | "task"
  timerShowTaskName: true,
  timerShowRemaining: true,
  timerShowPercent: true,
  timerShowCount: false,
  // Task list display
  showEta: true,
  showTaskRowRemaining: true,
  compactTasks: false,
  // Input
  defaultTimeUnit: "minutes",

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

function serializeState(state) {
  // Strip transient UI flags: editing on tasks, isListCreating
  // showHelp / showOptions / dark are intentionally persisted (user preference)
  const lists = {};
  for (const [k, arr] of Object.entries(state.lists || {})) {
    lists[k] = arr.map(({ editing: _editing, ...rest }) => rest);
  }
  return JSON.stringify({
    lists,
    listOrder: state.listOrder,
    currentList: state.currentList,
    currentTaskIndex: state.currentTaskIndex,
    listConfigs: state.listConfigs,
    dark: state.dark,
    showHelp: state.showHelp,
    showOptions: state.showOptions,
    // isListCreating intentionally omitted — always starts false
  });
}

/* ----------------------------- Utilities ------------------------------ */
const affirmations = ["Great job!", "Well done!", "You did it!", "Keep it up!", "Nice work!"];
const secs = (n) => n;
const mins = (n) => n * 60;
const hours = (n) => n * 3600;

function bestUnit(totalSeconds) {
  if (totalSeconds >= 3600 && totalSeconds % 3600 === 0) return "hours";
  if (totalSeconds >= 60 && totalSeconds % 60 === 0) return "minutes";
  return "seconds";
}
function toDisplayTime(totalSeconds, unit) {
  if (unit === "hours") return totalSeconds / 3600;
  if (unit === "minutes") return totalSeconds / 60;
  return totalSeconds;
}
function fromDisplayTime(value, unit) {
  if (unit === "hours") return Number(value) * 3600;
  if (unit === "minutes") return Number(value) * 60;
  return Number(value);
}

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
const YT_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function safeYtId(id) {
  return id && YT_ID_RE.test(id) ? id : null;
}

function ytIframeSrc(id) {
  // enablejsapi=1 allows control via postMessage; modest branding; no related; playsinline
  return `https://www.youtube.com/embed/${id}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1`;
}

/* Pure helper — takes an array directly, no state closure */
function nextEnabledIndexFrom(arr, start) {
  for (let k = start; k < arr.length; k++) if (arr[k].enabled) return k;
  return -1;
}

function postToYouTubeIframe(iframe, func) {
  // Uses player API via postMessage without loading extra JS
  try {
    iframe?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args: [] }),
      "https://www.youtube.com"
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
  const [ioStatus, setIoStatus] = useState(null);           // { type: 'success'|'error', msg: string } | null
  const ioStatusTimerRef = useRef(null);
  const [isRunning, setIsRunning] = useState(false);
  const [editValues, setEditValues] = useState({});       // { [taskIndex]: { name, time } }
  const [renamingTab, setRenamingTab] = useState(null);   // list name being renamed
  const [renamingTabValue, setRenamingTabValue] = useState("");
  const cancelRenameRef = useRef(false);
  const configRef = useRef(null);   // always-current config for timer callbacks
  const voicesRef = useRef([]);     // always-current voices for speak() inside interval
  const saveTimerRef = useRef(null);   // debounced localStorage write handle
  const stateRef = useRef(state);      // always-current state for event handlers
  // Form input refs — avoids imperative document.getElementById reads
  const taskNameRef = useRef(null);
  const taskTimeRef = useRef(null);
  const timeUnitRef = useRef(null);
  const createListNameRef = useRef(null);
  const timerRef = useRef(null);
  const audioCtxRef = useRef(null);
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

  /* Keep stateRef current so event handlers always see the latest state */
  useEffect(() => { stateRef.current = state; }, [state]);
  /* Keep voicesRef current so timer callbacks never use stale closures */
  useEffect(() => { voicesRef.current = voices; }, [voices]);

  /* Persist (debounced) + cross-tab broadcast.
     State is carried directly in the BC message — no race with the debounced LS write. */
  useEffect(() => {
    const serialized = serializeState(state);
    // Debounce localStorage writes to avoid thrashing during rapid timer ticks
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, serialized); } catch { /* ignore */ }
    }, 500);
    // Broadcast full serialized state immediately so other tabs don't read stale LS
    try {
      bcRef.current?.postMessage({ type: "STATE_UPDATE", data: serialized });
    } catch { /* ignore */ }
  }, [state]);

  /* Before unload: flush any pending debounced save immediately.
     Uses stateRef so we don't re-register this handler on every state change. */
  useEffect(() => {
    const handler = () => {
      clearTimeout(saveTimerRef.current);
      try { localStorage.setItem(LS_KEY, serializeState(stateRef.current)); } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []); // empty deps — intentional; stateRef stays current via the effect above

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
        // STATE_UPDATE carries the full serialized state — no LS read needed, no race condition
        if (msg?.data?.type === "STATE_UPDATE" && msg.data.data) {
          try {
            const incoming = JSON.parse(msg.data.data);
            const merged = {
              ...defaultState(),
              ...incoming,
              listConfigs: { default: defaultConfig(), ...(incoming?.listConfigs || {}) }
            };
            setState(() => migrateYouTubeMeta(merged));
          } catch { /* ignore */ }
        }
      };
    } catch { /* unsupported */ }

    return () => {
      window.removeEventListener("storage", onStorage);
      try { bcRef.current?.close?.(); } catch { /* ignore */ }
    };
  }, []);

  /* Cleanup on unmount — prevent interval and debounce leaks */
  useEffect(() => {
    return () => {
      clearInterval(timerRef.current);
      clearTimeout(saveTimerRef.current);
    };
  }, []);


  /* Voices — use addEventListener to avoid overwriting other handlers */
  useEffect(() => {
    const loadVoices = () => setVoices(window.speechSynthesis?.getVoices?.() || []);
    loadVoices();
    window.speechSynthesis?.addEventListener?.("voiceschanged", loadVoices);
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", loadVoices);
  }, []);

  /* Auto-focus the new-list name input when the create row appears */
  useEffect(() => {
    if (state.isListCreating) {
      // Defer one frame so the element is visible before focusing
      const id = requestAnimationFrame(() => createListNameRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [state.isListCreating]);

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

  /* Derived — deps scoped to only the values that can change them */
  const tasks = useMemo(() => state.lists[state.currentList] || [], [state.lists, state.currentList]);
  const config = useMemo(() => state.listConfigs[state.currentList] || defaultConfig(), [state.listConfigs, state.currentList]);
  /* Keep configRef current so timer callbacks never use stale closures */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { configRef.current = config; }, [config]);

  const listProgress = useMemo(() => {
    const enabled = tasks.filter((t) => t.enabled);
    const total = enabled.reduce((a, t) => a + (t.time || 0), 0);
    const done = enabled.reduce((a, t) => a + Math.max(0, t.time - t.remaining), 0);
    return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }, [tasks]);

  const taskProgress = useMemo(() => {
    const t = tasks[state.currentTaskIndex];
    if (!t || !t.time) return 0;
    return Math.min(100, Math.round(((t.time - t.remaining) / t.time) * 100));
  }, [tasks, state.currentTaskIndex]);

  const progress = config.progressBarMode === "task" ? taskProgress : listProgress;

  const currentTask = tasks[state.currentTaskIndex];
  const isWarning = config.warningThreshold > 0 && (currentTask?.remaining ?? 0) <= config.warningThreshold && (currentTask?.remaining ?? 0) > 0;
  const timerDisplayTime = config.timerDirection === "countup"
    ? (currentTask ? currentTask.time - currentTask.remaining : 0)
    : (currentTask?.remaining ?? 0);
  const enabledTaskCount = tasks.filter(t => t.enabled).length;
  const currentEnabledPos = tasks.slice(0, state.currentTaskIndex + 1).filter(t => t.enabled).length;

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
    if (name === state.currentList) pauseTimer();
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
    const name = (taskNameRef.current?.value ?? "").trim();
    const amt = Number(taskTimeRef.current?.value ?? 0);
    const unit = timeUnitRef.current?.value ?? "minutes";
    if (!name || !amt || amt <= 0) return;
    const toSeconds = unit === "seconds" ? secs : unit === "minutes" ? mins : hours;
    const t = toSeconds(amt);
    patch((n) => {
      const listTasks = n.lists[n.currentList];
      // Normalize so YT URL inputs get meta immediately
      const norm = normalizeTaskFromName(name, t);
      listTasks.push(norm);
    });
    if (taskNameRef.current) taskNameRef.current.value = "";
    if (taskTimeRef.current) taskTimeRef.current.value = "";
    taskNameRef.current?.focus();
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
    // only initiate drag when the pointer lands on the drag handle
    if (!e.target.closest('[data-drag-handle="true"]')) {
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

  /* speak and beep read from refs so they're safe to call inside the interval */
  function speak(text) {
    const cfg = configRef.current;
    if (!cfg?.ttsEnabled || !text) return;
    const utter = new SpeechSynthesisUtterance(text);
    const v = voicesRef.current.find((x) => x.name === cfg.selectedVoiceName);
    if (v) utter.voice = v;
    window.speechSynthesis.speak(utter);
  }

  function beep() {
    const cfg = configRef.current;
    if (!cfg?.beepEnabled) return;
    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") return;
    const toneHz = { low: 330, medium: 660, high: 990 }[cfg.beepTone || "medium"] ?? 660;
    const volume = cfg.beepVolume ?? 0.3;
    const count = Math.max(1, Math.min(3, cfg.beepCount || 1));
    const doPlay = () => {
      try {
        for (let i = 0; i < count; i++) {
          const t0 = ctx.currentTime + i * 0.35;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = "sine";
          osc.frequency.value = toneHz;
          gain.gain.setValueAtTime(volume, t0);
          gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
          osc.start(t0);
          osc.stop(t0 + 0.3);
        }
      } catch { /* ignore */ }
    };
    if (ctx.state === "suspended") {
      ctx.resume().then(doPlay).catch(() => {});
    } else {
      doPlay();
    }
  }

  /* Kept for call-sites outside the interval that pass state directly */
  function nextEnabledIndex(start) {
    return nextEnabledIndexFrom(stateRef.current.lists[stateRef.current.currentList] || [], start);
  }

  function taskTitleForTTS(task) {
    if (isYouTubeUrl(task.name)) return "YouTube video";
    return task.name;
  }

  function pauseAllYouTube() {
    try {
      const iframes = document.querySelectorAll('iframe[data-yt-frame="1"]');
      iframes.forEach((f) => postToYouTubeIframe(f, "pauseVideo"));
    } catch { /* ignore */ }
  }

  function playYouTubeIfAny(idx) {
    const key = `${stateRef.current.currentList}__${idx}`;
    const iframe = document.getElementById(`yt-iframe-${key}`);
    if (!iframe) return;
    postToYouTubeIframe(iframe, "playVideo");
  }

  function announceStart(task) {
    const cfg = configRef.current;
    const dur = ttsDuration(task.remaining);
    const title = taskTitleForTTS(task);
    if (cfg?.ttsMode === "taskNamePlusDurationStart") speak(`Starting ${title} for ${dur}`);
    else if (cfg?.ttsMode === "taskNameStart") speak(`Starting ${title}`);
    else if (cfg?.ttsMode === "durationStart") speak(`Starting ${dur}`);
  }

  function announceComplete() {
    const cfg = configRef.current;
    if (cfg?.ttsMode === "customCompletion") speak(cfg.ttsCustomMessage || "Task completed");
    else if (cfg?.ttsMode === "randomAffirmation") speak(affirmations[Math.floor(Math.random() * affirmations.length)]);
  }

  /* Core interval — extracted so both startTimer and completeEarly can reuse it */
  function _startInterval() {
    lastTick.current = performance.now();
    setIsRunning(true);

    timerRef.current = setInterval(() => {
      const now = performance.now();
      const dt = Math.min((now - (lastTick.current || now)) / 1000, 30);
      lastTick.current = now;

      // Compute side-effects from stateRef BEFORE patch() — React 18 batches setState
      // updaters asynchronously, so anything pushed inside patch() isn't available yet.
      const sideEffects = [];
      let timerEnded = false;
      {
        const s = stateRef.current;
        const arr = s.lists[s.currentList];
        if (!arr) {
          timerEnded = true;
        } else {
          let idx = s.currentTaskIndex;
          let timeLeft = dt;
          while (timeLeft > 0) {
            const t = arr[idx];
            if (!t) { timerEnded = true; break; }
            if (t.remaining <= timeLeft) {
              timeLeft -= t.remaining;
              sideEffects.push({ type: "complete" });
              const nxt = nextEnabledIndexFrom(arr, idx + 1);
              if (nxt === -1) { timerEnded = true; break; }
              if (!configRef.current?.autoAdvance) {
                sideEffects.push({ type: "advance", idx: nxt });
                timerEnded = true;
                break;
              }
              idx = nxt;
              sideEffects.push({ type: "start", task: arr[nxt], idx: nxt });
            } else {
              timeLeft = 0;
            }
          }
        }
      }

      // Apply state mutations
      patch((n) => {
        const arr = n.lists[n.currentList];
        if (!arr) return;
        let idx = n.currentTaskIndex;
        let timeLeft = dt;
        while (timeLeft > 0) {
          const t = arr[idx];
          if (!t) break;
          if (t.remaining <= timeLeft) {
            timeLeft -= t.remaining;
            t.remaining = 0;
            const nxt = nextEnabledIndexFrom(arr, idx + 1);
            if (nxt === -1) break;
            if (!configRef.current?.autoAdvance) { n.currentTaskIndex = nxt; break; }
            idx = nxt;
            n.currentTaskIndex = nxt;
          } else {
            t.remaining -= timeLeft;
            timeLeft = 0;
          }
        }
      });

      // Fire side-effects synchronously — sideEffects was populated before patch()
      for (const fx of sideEffects) {
        if (fx.type === "complete") {
          announceComplete();
        } else if (fx.type === "start") {
          beep();
          pauseAllYouTube();
          playYouTubeIfAny(fx.idx);
          announceStart(fx.task);
        } else if (fx.type === "advance") {
          pauseAllYouTube();
        }
      }

      if (timerEnded) {
        clearInterval(timerRef.current);
        timerRef.current = null;
        pauseAllYouTube();
        setIsRunning(false);
      }
    }, 200);
  }

  function startTimer() {
    if (timerRef.current) return;
    // Create AudioContext during the user gesture so it starts in "running" state immediately
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      } else if (audioCtxRef.current.state === "suspended") {
        audioCtxRef.current.resume().catch(() => {});
      }
    } catch { /* Web Audio not supported */ }
    const s = stateRef.current;
    const arr = s.lists[s.currentList] || [];
    const startIndex = nextEnabledIndexFrom(arr, s.currentTaskIndex);
    if (startIndex === -1) return;
    patch((n) => { n.currentTaskIndex = startIndex; });
    beep();
    announceStart(arr[startIndex]);
    pauseAllYouTube();
    playYouTubeIfAny(startIndex);
    _startInterval();
  }

  function pauseTimer() {
    if (!timerRef.current) return;
    clearInterval(timerRef.current);
    timerRef.current = null;
    setIsRunning(false);
    pauseAllYouTube();
  }

  function skipTask() {
    const s = stateRef.current;
    const arr = s.lists[s.currentList] || [];
    const nxt = nextEnabledIndexFrom(arr, s.currentTaskIndex + 1);
    if (nxt === -1) { showIoStatus("error", "No next task."); return; }
    const wasRunning = !!timerRef.current;
    pauseAllYouTube();
    beep();
    if (wasRunning) {
      lastTick.current = performance.now();
      patch((n) => { n.currentTaskIndex = nxt; });
      playYouTubeIfAny(nxt);
    } else {
      patch((n) => { n.currentTaskIndex = nxt; });
    }
  }

  function completeEarly() {
    const wasRunning = !!timerRef.current;
    pauseTimer();
    // Read synchronously via stateRef to avoid async setState race
    const s = stateRef.current;
    const arr = s.lists[s.currentList] || [];
    const nxt = nextEnabledIndexFrom(arr, s.currentTaskIndex + 1);
    patch((n) => {
      const t = n.lists[n.currentList][n.currentTaskIndex];
      if (t) t.remaining = 0;
      if (nxt !== -1) n.currentTaskIndex = nxt;
    });
    if (nxt !== -1) {
      beep();
      if (wasRunning) {
        announceStart(arr[nxt]);
        pauseAllYouTube();
        playYouTubeIfAny(nxt);
        _startInterval();
      }
    }
  }

  function restartTimer() {
    pauseTimer();
    patch((n) => {
      (n.lists[n.currentList] || []).forEach((t) => { t.remaining = t.time; });
      n.currentTaskIndex = 0;
    });
  }

  /* Import / Export */
  function showIoStatus(type, msg) {
    clearTimeout(ioStatusTimerRef.current);
    setIoStatus({ type, msg });
    ioStatusTimerRef.current = setTimeout(() => setIoStatus(null), 3000);
  }

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
    showIoStatus('success', 'Exported!');
  }

  function onFileLoaded(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showIoStatus("error", "File too large (max 5 MB).");
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const doc = new DOMParser().parseFromString(text, "application/xml");
        if (doc.querySelector("parsererror")) {
          showIoStatus('error', 'Invalid file format.');
          e.target.value = "";
          return;
        }
        const listNodes = [...doc.querySelectorAll("list")];
        if (!listNodes.length) {
          showIoStatus('error', 'No tasks found in file.');
          e.target.value = "";
          return;
        }
        let taskCount = 0;
        listNodes.forEach((ln) => { taskCount += ln.querySelectorAll("task").length; });
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
        const listWord = listNodes.length === 1 ? 'list' : 'lists';
        const taskWord = taskCount === 1 ? 'task' : 'tasks';
        showIoStatus('success', `Imported ${listNodes.length} ${listWord} with ${taskCount} ${taskWord}.`);
      } catch {
        showIoStatus('error', 'Invalid file format.');
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  }

  /* Render */
  const containerClasses = `container${state.dark ? " dark-mode" : ""}`;

  return (
    <>
    {/* Help full-screen overlay */}
    {state.showHelp && (
      <div className={`options-overlay${state.dark ? " dark-mode" : ""}`}>
        <div className="options-overlay-header">
          <span className="options-overlay-title">Help</span>
          <button
            className="options-close-button"
            onClick={() => patch((n) => { n.showHelp = false; })}
            aria-label="Close"
          >
            <i className="fas fa-xmark" />
          </button>
        </div>
        <div className="options-overlay-body help-overlay-body">
          <div className="help-card-overlay">
            <h3><i className="fas fa-list-check" /> Tasks &amp; Timing</h3>
            <ul className="help-list">
              <li><b>Add tasks:</b> Enter a task name and duration, choose units, then press <span className="kbd">+</span>.</li>
              <li><b>Select current:</b> Click any task row to set it as current.</li>
              <li><b>Enable/disable:</b> Use the toggle on each task to include or exclude it from the run.</li>
              <li><b>Start/Pause:</b> Use <span className="btn-chip">Start</span> and <span className="btn-chip">Pause</span>.</li>
              <li><b>Skip:</b> Jumps to the next enabled task without changing remaining time.</li>
              <li><b>Complete early:</b> Marks the current task done immediately and advances.</li>
              <li><b>Restart:</b> Resets all tasks' remaining time to their original durations.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fab fa-youtube" /> YouTube Playlists</h3>
            <ul className="help-list">
              <li><b>Create a video task:</b> Paste a YouTube URL directly in the Task Name field.</li>
              <li><b>Auto-play:</b> Playback begins automatically when a video task becomes current.</li>
              <li><b>Import support:</b> Imported lists auto-detect YouTube URLs and embed videos.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-pen-to-square" /> Editing &amp; Menus</h3>
            <ul className="help-list">
              <li><b>Quick actions:</b> Use the <span className="dots">…</span> button on a task for Edit/Delete.</li>
              <li><b>Edit:</b> Change the task name and total time. Remaining updates when total changes.</li>
              <li><b>List menus:</b> Use the <span className="dots">…</span> on a tab for Rename/Delete.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-arrows-up-down-left-right" /> Reordering</h3>
            <ul className="help-list">
              <li><b>Tasks:</b> Press and drag anywhere on a task row to reorder.</li>
              <li><b>Lists:</b> Drag tabs to rearrange list order.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-file-import" /> Import / Export</h3>
            <ul className="help-list">
              <li><b>Export:</b> Downloads an XML snapshot including YouTube metadata.</li>
              <li><b>Import:</b> XML files automatically detect YouTube URLs and embed videos.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-cloud" /> Persistence &amp; Sync</h3>
            <ul className="help-list">
              <li><b>Auto-save:</b> All lists, progress, and settings persist in the browser.</li>
              <li><b>Cross-tab sync:</b> Changes propagate immediately across open tabs.</li>
              <li><b>Dark mode:</b> Toggle from the header. Theme preference persists.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-circle-question" /> Tips</h3>
            <ul className="help-list">
              <li>Use multiple lists to separate focus blocks, study sets, or workout circuits.</li>
              <li>Disable tasks you want to skip without losing their setup.</li>
              <li>Keep YouTube tasks near relevant steps; auto-play aligns video and timing.</li>
            </ul>
          </div>
        </div>
      </div>
    )}

    {/* Options full-screen overlay */}
    {state.showOptions && (
      <div className={`options-overlay${state.dark ? " dark-mode" : ""}`}>
        <div className="options-overlay-header">
          <span className="options-overlay-title">Settings</span>
          <button
            className="options-close-button"
            onClick={() => patch((n) => { n.showOptions = false; })}
            aria-label="Close"
          >
            <i className="fas fa-xmark" />
          </button>
        </div>
        <div className="options-overlay-body">
          <div className="options-section">
            <p className="options-section-label">Audio</p>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="beepCheckbox">Enable Beep</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="beepCheckbox" className="enable-checkbox" checked={!!config.beepEnabled}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].beepEnabled = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="beepCheckbox"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="ttsCheckbox">Enable Text-to-Speech</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="ttsCheckbox" className="enable-checkbox" checked={!!config.ttsEnabled}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].ttsEnabled = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="ttsCheckbox"></label>
              </div>
            </div>
          </div>
          <div className="options-section">
            <p className="options-section-label">Display</p>
            <div className={`option-row option-row--field${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="progressBarMode">Progress Bar</label>
              <select id="progressBarMode" value={config.progressBarMode || "list"}
                onChange={(e) => patch((n) => { n.listConfigs[n.currentList].progressBarMode = e.target.value; })}>
                <option value="list">Overall list progress</option>
                <option value="task">Current task progress</option>
              </select>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="timerShowTaskName">Show task name</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="timerShowTaskName" className="enable-checkbox"
                  checked={config.timerShowTaskName !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].timerShowTaskName = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="timerShowTaskName"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="timerShowRemaining">Show time remaining</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="timerShowRemaining" className="enable-checkbox"
                  checked={config.timerShowRemaining !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].timerShowRemaining = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="timerShowRemaining"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="timerShowPercent">Show percentage</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="timerShowPercent" className="enable-checkbox"
                  checked={config.timerShowPercent !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].timerShowPercent = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="timerShowPercent"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="timerShowCount">Show task count (e.g. 2 / 5)</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="timerShowCount" className="enable-checkbox"
                  checked={!!config.timerShowCount}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].timerShowCount = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="timerShowCount"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="showEta">Show ETA bar</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="showEta" className="enable-checkbox"
                  checked={config.showEta !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].showEta = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="showEta"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="showTaskRowRemaining">Show time on each task row</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="showTaskRowRemaining" className="enable-checkbox"
                  checked={config.showTaskRowRemaining !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].showTaskRowRemaining = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="showTaskRowRemaining"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="compactTasks">Compact task list</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="compactTasks" className="enable-checkbox"
                  checked={!!config.compactTasks}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].compactTasks = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="compactTasks"></label>
              </div>
            </div>
          </div>

          <div className="options-section">
            <p className="options-section-label">Timer</p>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="autoAdvance">Auto-start next task</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="autoAdvance" className="enable-checkbox"
                  checked={config.autoAdvance !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].autoAdvance = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="autoAdvance"></label>
              </div>
            </div>
            <div className={`option-row option-row--field${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="timerDirection">Timer counts</label>
              <select id="timerDirection" value={config.timerDirection || "countdown"}
                onChange={(e) => patch((n) => { n.listConfigs[n.currentList].timerDirection = e.target.value; })}>
                <option value="countdown">Down (time remaining)</option>
                <option value="countup">Up (time elapsed)</option>
              </select>
            </div>
            <div className={`option-row option-row--field${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="warningThreshold">Warning when ≤ (seconds, 0 = off)</label>
              <input type="number" id="warningThreshold" min="0" max="3600"
                value={config.warningThreshold ?? 0}
                onChange={(e) => patch((n) => { n.listConfigs[n.currentList].warningThreshold = Math.max(0, Number(e.target.value)); })} />
            </div>
          </div>

          <div className="options-section">
            <p className="options-section-label">Audio</p>
            <div className={`option-row option-row--field${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="beepVolume">Beep volume ({Math.round((config.beepVolume ?? 0.3) * 100)}%)</label>
              <input type="range" id="beepVolume" min="0" max="1" step="0.05"
                value={config.beepVolume ?? 0.3}
                onChange={(e) => patch((n) => { n.listConfigs[n.currentList].beepVolume = Number(e.target.value); })} />
            </div>
            <div className={`option-row option-row--field${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="beepTone">Beep tone</label>
              <select id="beepTone" value={config.beepTone || "medium"}
                onChange={(e) => patch((n) => { n.listConfigs[n.currentList].beepTone = e.target.value; })}>
                <option value="low">Low (330 Hz)</option>
                <option value="medium">Medium (660 Hz)</option>
                <option value="high">High (990 Hz)</option>
              </select>
            </div>
            <div className={`option-row option-row--field${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="beepCount">Beep count</label>
              <select id="beepCount" value={config.beepCount ?? 1}
                onChange={(e) => patch((n) => { n.listConfigs[n.currentList].beepCount = Number(e.target.value); })}>
                <option value={1}>Single</option>
                <option value={2}>Double</option>
                <option value={3}>Triple</option>
              </select>
            </div>
          </div>

          <div className="options-section">
            <p className="options-section-label">General</p>
            <div className={`option-row option-row--field${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="defaultTimeUnit">Default time unit</label>
              <select id="defaultTimeUnit" value={config.defaultTimeUnit || "minutes"}
                onChange={(e) => patch((n) => { n.listConfigs[n.currentList].defaultTimeUnit = e.target.value; })}>
                <option value="seconds">Seconds</option>
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
              </select>
            </div>

          </div>

          <div className="options-section">
            <p className="options-section-label">Voice</p>
            <div className={`option-row option-row--field${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="voiceSelect">Voice</label>
              <select id="voiceSelect" value={config.selectedVoiceName || (voices[0]?.name || "")}
                onChange={(e) => patch((n) => { n.listConfigs[n.currentList].selectedVoiceName = e.target.value; })}>
                {voices.map((v) => <option key={v.name} value={v.name}>{v.name}{v.default ? " (default)" : ""}</option>)}
              </select>
            </div>
            <div className={`option-row option-row--field${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="ttsModeSelect">Announce</label>
              <select id="ttsModeSelect" value={config.ttsMode}
                onChange={(e) => patch((n) => { n.listConfigs[n.currentList].ttsMode = e.target.value; })}>
                <option value="taskNamePlusDurationStart">Start: Task name + duration</option>
                <option value="taskNameStart">Start: Task name only</option>
                <option value="durationStart">Start: Duration only</option>
                <option value="customCompletion">Completion: Custom message</option>
                <option value="randomAffirmation">Completion: Random affirmation</option>
              </select>
            </div>
            {config.ttsMode === "customCompletion" && (
              <div className={`option-row option-row--field${state.dark ? " dark-mode" : ""}`}>
                <label htmlFor="ttsCustomMessage">Message</label>
                <input type="text" id="ttsCustomMessage" placeholder="e.g. Task completed!"
                  value={config.ttsCustomMessage}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].ttsCustomMessage = e.target.value; })} />
              </div>
            )}
          </div>
        </div>
      </div>
    )}
    <div className={containerClasses}>
      <header>
        <h1>TimeTallyToo</h1>
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
            <i className={`fas fa-${state.dark ? "sun" : "moon"}`} />
          </button>
        </div>
      </header>


      {/* Tabs + inline list creation */}
      <div id="tabsContainer" className="tabs-container">
        {state.listOrder.map((name, idx) => {
          const active = name === state.currentList;
          const taskCount = (state.lists[name] || []).length;
          const cls = `tab${active ? " active" : ""}`;
          return (
            <div
              key={name}
              className={cls}
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
              {renamingTab === name ? (
                <input
                  type="text"
                  className="tab-edit-input"
                  value={renamingTabValue}
                  onChange={(e) => setRenamingTabValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (renamingTabValue.trim()) renameList(name, renamingTabValue.trim());
                      cancelRenameRef.current = true;
                      setRenamingTab(null);
                    } else if (e.key === "Escape") {
                      cancelRenameRef.current = true;
                      setRenamingTab(null);
                    }
                  }}
                  onBlur={() => {
                    if (!cancelRenameRef.current && renamingTabValue.trim()) {
                      renameList(name, renamingTabValue.trim());
                    }
                    cancelRenameRef.current = false;
                    setRenamingTab(null);
                  }}
                  autoFocus
                />
              ) : (
                <span className="tab-name">{name}</span>
              )}

              {taskCount > 0 && <span className="tab-count">{taskCount}</span>}

              <button
                className="icon-button ellipsis-button tab-menu-btn"
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
                      setRenamingTab(name);
                      setRenamingTabValue(name);
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

        {/* Inline creation chip OR the + button */}
        {state.isListCreating ? (
          <div className="tab-create-inline">
            <input
              ref={createListNameRef}
              placeholder="List name…"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = (createListNameRef.current?.value ?? "").trim();
                  if (val) { addList(val); if (createListNameRef.current) createListNameRef.current.value = ""; }
                } else if (e.key === "Escape") {
                  patch((n) => { n.isListCreating = false; });
                }
              }}
            />
            <button
              className="tab-create-save"
              title="Save list"
              onClick={() => {
                const val = (createListNameRef.current?.value ?? "").trim();
                if (val) addList(val);
                if (createListNameRef.current) createListNameRef.current.value = "";
              }}
            >
              <i className="fas fa-check" />
            </button>
            <button
              className="tab-create-cancel"
              title="Cancel"
              onClick={() => patch((n) => { n.isListCreating = false; })}
            >
              <i className="fas fa-times" />
            </button>
          </div>
        ) : (
          <button
            className="tab-add-btn"
            title="New list"
            onClick={() => { setMenuOpenTab(null); patch((n) => { n.isListCreating = true; }); }}
          >
            <i className="fas fa-plus" />
          </button>
        )}
      </div>

      {/* ETA — only render when there is something to show */}
      {config.showEta !== false && etaText && (
        <div className={`section-box${state.dark ? " dark-mode" : ""}`}>
          <div className={`estimated-finish${state.dark ? " dark-mode" : ""}`} id="estimatedFinishTime">
            {etaText}
          </div>
        </div>
      )}

      {/* Task input */}
      <div className={`section-box${state.dark ? " dark-mode" : ""}`}>
        <div className={`task-input${state.dark ? " dark-mode" : ""}`}>
          <label htmlFor="taskName" className="sr-only">Task name or YouTube URL</label>
          <input
            type="text"
            id="taskName"
            ref={taskNameRef}
            placeholder="Task Name or YouTube URL"
            onKeyDown={(e) => { if (e.key === "Enter") taskTimeRef.current?.focus(); }}
          />
          <label htmlFor="taskTime" className="sr-only">Duration</label>
          <input
            type="number"
            id="taskTime"
            ref={taskTimeRef}
            placeholder="Time"
            onKeyDown={(e) => { if (e.key === "Enter") addTaskUI(); }}
          />
          <select key={config.defaultTimeUnit} id="timeUnit" ref={timeUnitRef} aria-label="Time Unit" defaultValue={config.defaultTimeUnit || "minutes"}>
            <option value="seconds">Seconds</option>
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
          </select>
          <button onClick={addTaskUI} title="Add Task" aria-label="Add task">
            <i className="fas fa-plus" />
          </button>
        </div>
      </div>

      {/* Task list */}
      <ul id="taskList" ref={listRef} className={config.compactTasks ? "compact" : ""}>
        {tasks.map((t, i) => {
          const isCurrent = i === state.currentTaskIndex;
          const itemCls = `task-item${isCurrent ? " current" : ""}${!t.enabled ? " disabled" : ""}${t.editing ? " editing" : ""}${state.dark ? " dark-mode" : ""}`;
          // Validate ytId against the strict 11-char regex before embedding
          const ytId = safeYtId(t?.meta?.ytId || (isYouTubeUrl(t.name) ? parseYouTubeId(t.name) : null));
          const key = `${state.currentList}__${i}`;

          const saveEdit = (e) => {
            e?.stopPropagation();
            const ev = editValues[i] || {};
            const newName = String(ev.name ?? t.name).trim();
            const newTime = fromDisplayTime(ev.time ?? t.time, ev.unit || "seconds");
            if (newName && newTime > 0) editTask(i, { name: newName, time: newTime });
            editTask(i, { editing: false });
            setEditValues((prev) => { const next = { ...prev }; delete next[i]; return next; });
            setMenuOpenTask(null);
          };
          const cancelEdit = (e) => {
            e?.stopPropagation();
            editTask(i, { editing: false });
            setEditValues((prev) => { const next = { ...prev }; delete next[i]; return next; });
            setMenuOpenTask(null);
          };

          return (
            <li
              key={i}
              className={itemCls}
              style={{ position: "relative" }}
              onPointerDown={(e) => onTaskPointerDown(i, e)}
              onPointerMove={onTaskPointerMove}
              onPointerUp={onTaskPointerUp}
              onPointerCancel={onTaskPointerUp}
              onClick={(e) => {
                if (e.target.closest(".task-actions")) return;
                if (!t.enabled) return;
                setMenuOpenTask(null);
                patch((n) => { n.currentTaskIndex = i; });
              }}
            >
              <div
                className="drag-handle"
                data-drag-handle="true"
                title="Drag to reorder"
                onClick={(e) => e.stopPropagation()}
              >
                <i className="fas fa-grip-vertical" />
              </div>
              <div className="task-details">
                {t.editing ? (
                  <div className="task-edit-inline" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="text"
                      value={editValues[i]?.name ?? t.name}
                      onChange={(e) => setEditValues((prev) => ({ ...prev, [i]: { ...(prev[i] || {}), name: e.target.value } }))}
                      placeholder="Task name or YouTube URL"
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEdit(e); } else if (e.key === "Escape") cancelEdit(e); }}
                      autoFocus
                    />
                    <div className="task-edit-time-row">
                      <input
                        type="number"
                        value={editValues[i]?.time ?? t.time}
                        onChange={(e) => setEditValues((prev) => ({ ...prev, [i]: { ...(prev[i] || {}), time: e.target.value } }))}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEdit(e); } else if (e.key === "Escape") cancelEdit(e); }}
                        min="1"
                      />
                      <select
                        className="task-edit-unit-select"
                        value={editValues[i]?.unit ?? "seconds"}
                        onChange={(e) => setEditValues((prev) => ({ ...prev, [i]: { ...(prev[i] || {}), unit: e.target.value } }))}
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <option value="seconds">Seconds</option>
                        <option value="minutes">Minutes</option>
                        <option value="hours">Hours</option>
                      </select>
                    </div>
                    <div className="task-edit-actions">
                      <button className="task-edit-save" onClick={saveEdit}>
                        <i className="fas fa-check" /> Save
                      </button>
                      <button className="task-edit-cancel" onClick={cancelEdit}>
                        <i className="fas fa-times" /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="task-name">
                      {isYouTubeUrl(t.name) ? "YouTube video" : t.name}
                    </div>
                    {config.showTaskRowRemaining !== false && (
                      <div className="task-time">
                        ({formatHMS(config.timerDirection === "countup" ? t.time - t.remaining : t.remaining)} {config.timerDirection === "countup" ? "elapsed" : "remaining"})
                      </div>
                    )}

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
                  </>
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
                      onClick={() => {
                        const unit = bestUnit(t.time);
                        setEditValues((prev) => ({ ...prev, [i]: { name: t.name, time: toDisplayTime(t.time, unit), unit } }));
                        editTask(i, { editing: true });
                        setMenuOpenTask(null);
                      }}
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

              </div>
            </li>
          );
        })}
      </ul>
      {tasks.length === 0 && (
        <div className="empty-state">
          <i className="fas fa-list-check" />
          <p>No tasks yet. Add one above to get started.</p>
        </div>
      )}

      {/* Sticky controls footer */}
      <div className={`controls-footer${state.dark ? " dark-mode" : ""}${isRunning ? " running" : ""}${isWarning ? " warning" : ""}`}>

        {/* Timer */}
        <div className={`timer-section${state.dark ? " dark-mode" : ""}`}>
          <div className={`progress-container${state.dark ? " dark-mode" : ""}`}>
            <div className={`progress-bar${state.dark ? " dark-mode" : ""}`} style={{ width: `${progress}%` }} />
          </div>
          <div className={`timer-info${state.dark ? " dark-mode" : ""}`}>
            {config.timerShowTaskName && (
              <div id="timerText" className="timer-task-name">
                {currentTask ? (isYouTubeUrl(currentTask.name) ? "YouTube video" : currentTask.name) : "Ready"}
              </div>
            )}
            {config.timerShowCount && enabledTaskCount > 0 && (
              <div className="timer-count">{currentEnabledPos} / {enabledTaskCount}</div>
            )}
            {config.timerShowRemaining && (
              <div className="timer-remaining">{formatHMS(timerDisplayTime)}</div>
            )}
            {config.timerShowPercent && (
              <div id="timerPercent" className="timer-percent">{progress}%</div>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="controls">
          <button
            className={isRunning ? "btn-pause" : "btn-start"}
            onClick={isRunning ? pauseTimer : startTimer}
            title={isRunning ? "Pause Timer" : "Start Timer"}
            aria-label={isRunning ? "Pause timer" : "Start timer"}
          >
            <i className={`fas fa-${isRunning ? "pause" : "play"}`} />
            {isRunning ? " Pause" : " Start"}
          </button>
          <button className="btn-skip" onClick={skipTask} title="Skip Current Task" aria-label="Skip current task"><i className="fas fa-forward" /> Skip</button>
          <button className="btn-complete" onClick={completeEarly} title="Complete Early" aria-label="Complete current task early"><i className="fas fa-check" /> Complete</button>
          <button className="btn-red" onClick={restartTimer} title="Restart All Tasks" aria-label="Restart all tasks"><i className="fas fa-undo-alt" /> Restart</button>
        </div>

      </div>

      {/* Import / Export */}
      <div className="import-export">
        <div className="import-export-buttons">
          <button className="btn-export" onClick={exportTasksToXML} title="Export Tasks">
            <i className="fas fa-file-export" /> Export Tasks
          </button>
          <button id="importFileBttn" onClick={() => document.getElementById("importFile").click()} title="Import Tasks">
            <i className="fas fa-file-import" /> Import Tasks
          </button>
          <input
            type="file"
            id="importFile"
            accept=".xml"
            onChange={onFileLoaded}
            style={{ display: "none" }}
          />
        </div>
        {ioStatus && (
          <p className={`io-status io-status--${ioStatus.type}${state.dark ? " dark-mode" : ""}`}>
            {ioStatus.msg}
          </p>
        )}
      </div>
    </div>
    </>
  );
}
