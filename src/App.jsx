import React, { useEffect, useMemo, useRef, useState } from "react";
// Fix #9: sub-components for render isolation (React.memo prevents re-renders
// on unrelated parent state changes, e.g. every 200ms timer tick).
import TimerFooter from "./components/TimerFooter";
import TaskList from "./components/TaskList";

/* ------------------------- App metadata ------------------------- */
const APP_VERSION = __APP_VERSION__;
const REPO_URL = "https://github.com/woodtho/TimeTallyToo";

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
  // Celebrations (per-list whimsy toggles)
  whimsyAffirmationToast: true,
  whimsyCompletionFlash: true,
  whimsyRowPulse: true,
  whimsyStrikeThrough: true,
  whimsyListComplete: true,
  whimsyCompletionChord: true,
});

const defaultListStats = () => ({
  tasksCompleted: 0,
  timeWorked: 0,      // cumulative seconds
  sessionsCompleted: 0,
  lastSession: null,  // ISO 8601 string or null
});

const defaultState = () => ({
  lists: { default: [] },
  listOrder: ["default"],
  currentList: "default",
  currentTaskIndex: 0,
  listConfigs: { default: defaultConfig() },
  listStats: { default: defaultListStats() },
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
    return { id: crypto.randomUUID(), name, time: timeSeconds, remaining: timeSeconds, enabled: true, editing: false, meta: { ytUrl: name, ytId } };
  }
  return { id: crypto.randomUUID(), name, time: timeSeconds, remaining: timeSeconds, enabled: true, editing: false };
}

/* Migration to ensure all tasks have a stable id field */
function migrateTaskIds(state) {
  const next = structuredClone(state);
  let changed = false;
  for (const listName of Object.keys(next.lists || {})) {
    const arr = next.lists[listName] || [];
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i].id) {
        arr[i] = { ...arr[i], id: crypto.randomUUID() };
        changed = true;
      }
    }
  }
  return changed ? next : state;
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
    // Deep-merge each per-list config with defaultConfig() so any fields added
    // after the state was first saved pick up their correct default values.
    const parsedConfigs = parsed?.listConfigs || {};
    const mergedConfigs = {};
    for (const [k, cfg] of Object.entries(parsedConfigs)) {
      mergedConfigs[k] = { ...defaultConfig(), ...cfg };
    }
    if (!mergedConfigs.default) mergedConfigs.default = defaultConfig();
    // Same deep-merge for listStats so new stat fields get defaults automatically.
    const parsedStats = parsed?.listStats || {};
    const mergedStats = {};
    for (const [k, s] of Object.entries(parsedStats)) {
      mergedStats[k] = { ...defaultListStats(), ...s };
    }
    if (!mergedStats.default) mergedStats.default = defaultListStats();
    const merged = {
      ...defaultState(),
      ...parsed,
      listConfigs: mergedConfigs,
      listStats: mergedStats,
    };
    // Run migrations so any old data with YT URLs but no meta still embeds,
    // and any tasks missing a stable id get one assigned.
    return migrateYouTubeMeta(migrateTaskIds(merged));
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
    listStats: state.listStats,
    dark: state.dark,
    showHelp: state.showHelp,
    showOptions: state.showOptions,
    // isListCreating intentionally omitted — always starts false
  });
}

/* ----------------------------- Utilities ------------------------------ */
const affirmations = ["Great job!", "Well done!", "You did it!", "Keep it up!", "Nice work!"];

const EMPTY_STATES = [
  { msg: "Your task list is refreshingly empty. That won't last.", icon: "fa-hourglass-start" },
  { msg: "Nothing here yet. The clock is patient.", icon: "fa-clock" },
  { msg: "A blank slate. All the possibilities.", icon: "fa-seedling" },
  { msg: "Suspiciously task-free. Let's fix that.", icon: "fa-bolt" },
  { msg: "No tasks. No pressure. Add one when you're ready.", icon: "fa-list-check" },
];
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
  // enablejsapi=1 allows control via postMessage; autoplay=1 starts playback as soon as
  // the iframe loads (reliable since the iframe only mounts when the task is current).
  return `https://www.youtube.com/embed/${id}?enablejsapi=1&autoplay=1&rel=0&modestbranding=1&playsinline=1`;
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
  const [showStats, setShowStats] = useState(false);
  const [startPulse, setStartPulse] = useState(false);   // start-button ring animation
  const [newTaskId, setNewTaskId] = useState(null);       // slide-in for just-added task
  const [skipAnim, setSkipAnim] = useState(null);         // { from, to } for skip swipe
  const [droppedIndex, setDroppedIndex] = useState(null); // landing ripple after drag
  const [affirmationToast, setAffirmationToast] = useState(null);
  const [completionFlash, setCompletionFlash] = useState(false);
  const [listComplete, setListComplete] = useState(false);
  const affirmationTimerRef = useRef(null);
  const listCompleteTimerRef = useRef(null);
  const [editValues, setEditValues] = useState({});       // { [task.id]: { name, time } }
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
  const sessionAccrualRef = useRef(0); // accumulates elapsed seconds during a running session
  const draggedTabIndex = useRef(null);
  const bcRef = useRef(null);                               // BroadcastChannel ref
  const importFileRef = useRef(null); // Fix #2: replaces document.getElementById("importFile")

  // task DnD (pointer-based for mobile + desktop)
  const listRef = useRef(null);
  const draggingTask = useRef(null);
  const pointerActive = useRef(false);
  const didReorderRef = useRef(false); // tracks whether a drag actually moved a task

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
            // Stop this tab's running timer before applying incoming state so both tabs
            // don't decrement the same task simultaneously.
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
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

  /* Cleanup on unmount — prevent interval, debounce, and AudioContext leaks.
     Fix #8: Close AudioContext on unmount. Browsers cap simultaneous contexts
     (Chrome: 6); failing to close them causes silent failures on re-open. */
  useEffect(() => {
    return () => {
      clearInterval(timerRef.current);
      clearTimeout(saveTimerRef.current);
      clearTimeout(affirmationTimerRef.current);
      clearTimeout(listCompleteTimerRef.current);
      // Fix #8: close AudioContext so the browser slot is freed immediately
      try { audioCtxRef.current?.close(); } catch { /* ignore */ }
      audioCtxRef.current = null;
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

  /* Tab scroll affordance — fade edges + has-scrolled class */
  useEffect(() => {
    const container = document.getElementById("tabsContainer");
    const wrapper = container?.parentElement;
    if (!container || !wrapper) return;
    const update = () => {
      const overflow = container.scrollWidth - container.clientWidth;
      wrapper.classList.toggle("no-overflow", overflow <= 4);
      wrapper.classList.toggle("has-scrolled", container.scrollLeft > 4);
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    return () => {
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [state.listOrder]);

  /* One-time nudge hint — fires once ever if tab bar overflows */
  useEffect(() => {
    const container = document.getElementById("tabsContainer");
    if (!container) return;
    if (localStorage.getItem("tabs_nudge_seen")) return;
    const tid = setTimeout(() => {
      if (container.scrollWidth > container.clientWidth + 4) {
        container.classList.add("tabs-nudge");
        localStorage.setItem("tabs_nudge_seen", "1");
        container.addEventListener("animationend", () => container.classList.remove("tabs-nudge"), { once: true });
      }
    }, 700);
    return () => clearTimeout(tid);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* Peek: switching tabs scrolls so the next tab is partially visible */
  useEffect(() => {
    const container = document.getElementById("tabsContainer");
    if (!container) return;
    const active = container.querySelector(".tab.active");
    if (!active) return;
    const PEEK = 30; // px of the following tab to expose
    const containerRect = container.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    const tabRight = tabRect.right - containerRect.left + container.scrollLeft;
    const targetRight = tabRight - container.clientWidth + PEEK;
    if (targetRight > container.scrollLeft + 4) {
      container.scrollTo({ left: targetRight, behavior: "smooth" });
    } else if (tabRect.left < containerRect.left + 4) {
      const tabLeft = tabRect.left - containerRect.left + container.scrollLeft;
      container.scrollTo({ left: Math.max(0, tabLeft - 8), behavior: "smooth" });
    }
  }, [state.currentList]);

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
  const isLastFive = isRunning && !!(currentTask && currentTask.remaining > 0 && currentTask.remaining <= 5);
  const timerDisplayTime = config.timerDirection === "countup"
    ? (currentTask ? currentTask.time - currentTask.remaining : 0)
    : (currentTask?.remaining ?? 0);
  const enabledTaskCount = tasks.filter(t => t.enabled).length;
  const currentEnabledPos = tasks.slice(0, state.currentTaskIndex + 1).filter(t => t.enabled).length;

  const emptyState = useMemo(
    () => EMPTY_STATES[Math.floor(Math.random() * EMPTY_STATES.length)],
    // Re-pick when the user switches lists; stable during re-renders of same list
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.currentList]
  );

  /* Stats helpers */
  const currentListStats = useMemo(
    () => ({ ...defaultListStats(), ...(state.listStats?.[state.currentList] || {}) }),
    [state.listStats, state.currentList]
  );
  const allStats = useMemo(() => {
    const all = Object.values(state.listStats || {});
    return {
      tasksCompleted: all.reduce((a, s) => a + (s.tasksCompleted || 0), 0),
      timeWorked: all.reduce((a, s) => a + (s.timeWorked || 0), 0),
      sessionsCompleted: all.reduce((a, s) => a + (s.sessionsCompleted || 0), 0),
    };
  }, [state.listStats]);

  function formatTimeWorked(seconds) {
    const s = Math.floor(seconds || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${r}s`;
    return `${r}s`;
  }

  function formatLastSession(iso) {
    if (!iso) return "never";
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch { return "—"; }
  }

  function resetCurrentListStats() {
    patch((n) => { n.listStats[n.currentList] = defaultListStats(); });
  }

  const etaText = useMemo(() => {
    const secsLeft = sumEnabledRemaining(tasks);
    if (secsLeft <= 0) return "";
    const finish = new Date(Date.now() + secsLeft * 1000);
    const hh = String(finish.getHours()).padStart(2, "0");
    const mm = String(finish.getMinutes()).padStart(2, "0");
    return `ETA: ${hh}:${mm} · ${formatHMS(secsLeft)} remaining`;
  }, [tasks]);

  /* State helpers */
  // Fix #5: replaced structuredClone (full deep-copy ran every 200ms tick) with a
  // targeted two-level shallow copy. migrateYouTubeMeta was also called on every
  // patch() — it now only runs at load/import time (one-off operations).
  // The shallow copy is sufficient because patch() callbacks only mutate task
  // objects inside the current list array, which we shallow-copy here.
  const patch = (fn) => setState((s) => {
    const next = {
      ...s,
      lists: { ...s.lists },
      listConfigs: { ...s.listConfigs },
      listStats: { ...s.listStats },
    };
    // Shallow-copy the current list's array, config, and stats to avoid mutating
    // the previous state — required by React's immutability contract.
    const cl = s.currentList;
    if (next.lists[cl]) next.lists[cl] = [...next.lists[cl]];
    if (next.listConfigs[cl]) next.listConfigs[cl] = { ...next.listConfigs[cl] };
    if (next.listStats[cl]) next.listStats[cl] = { ...next.listStats[cl] };
    fn(next);
    return next;
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
      n.listStats[name] = defaultListStats();
      n.currentList = name;
      n.currentTaskIndex = 0;
      n.isListCreating = false;
    });
    // Spring-in animation on the new tab after React paints it
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const tabEl = document.querySelector(`[data-list-name="${CSS.escape(name)}"]`);
        if (!tabEl) return;
        tabEl.classList.add("tab--arrived");
        tabEl.addEventListener("animationend", () => tabEl.classList.remove("tab--arrived"), { once: true });
      });
    });
  }

  function renameList(oldName, newName) {
    if (!newName || oldName === newName || state.lists[newName]) return;
    patch((n) => {
      n.lists[newName] = n.lists[oldName];
      delete n.lists[oldName];
      n.listConfigs[newName] = n.listConfigs[oldName];
      delete n.listConfigs[oldName];
      n.listStats[newName] = n.listStats[oldName] || defaultListStats();
      delete n.listStats[oldName];
      n.listOrder = n.listOrder.map((x) => (x === oldName ? newName : x));
      if (n.currentList === oldName) n.currentList = newName;
    });
  }

  function deleteList(name) {
    if (state.listOrder.length <= 1) return;
    const doDelete = () => {
      if (name === state.currentList) pauseTimer();
      patch((n) => {
        delete n.lists[name];
        delete n.listConfigs[name];
        delete n.listStats[name];
        n.listOrder = n.listOrder.filter((x) => x !== name);
        if (n.currentList === name) n.currentList = n.listOrder[0];
        n.currentTaskIndex = 0;
      });
    };
    const tabEl = document.querySelector(`[data-list-name="${CSS.escape(name)}"]`);
    if (tabEl) {
      tabEl.classList.add("tab--removing");
      setTimeout(doDelete, 220);
    } else {
      doDelete();
    }
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
    const norm = normalizeTaskFromName(name, t);
    patch((n) => {
      n.lists[n.currentList].push(norm);
    });
    setNewTaskId(norm.id);
    setTimeout(() => setNewTaskId(null), 350);
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
    didReorderRef.current = false;
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
      didReorderRef.current = true;
    }
  }

  function onTaskPointerUp() {
    if (!pointerActive.current) return;
    const finalIdx = draggingTask.current;
    pointerActive.current = false;
    draggingTask.current = null;
    document.body.style.touchAction = "";
    if (didReorderRef.current && finalIdx !== null) {
      setDroppedIndex(finalIdx);
      setTimeout(() => setDroppedIndex(null), 500);
    }
    didReorderRef.current = false;
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

  function beepChord() {
    const cfg = configRef.current;
    if (!cfg?.beepEnabled || !cfg?.whimsyCompletionChord) return;
    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") return;
    const root = { low: 330, medium: 660, high: 990 }[cfg.beepTone || "medium"] ?? 660;
    const notes = [root, root * 1.25, root * 1.5];
    const volume = cfg.beepVolume ?? 0.3;
    const doPlay = () => {
      try {
        notes.forEach((hz, i) => {
          const t0 = ctx.currentTime + i * 0.08;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain); gain.connect(ctx.destination);
          osc.type = "sine";
          osc.frequency.value = hz;
          gain.gain.setValueAtTime(volume, t0);
          gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.7);
          osc.start(t0); osc.stop(t0 + 0.7);
        });
      } catch { /* ignore */ }
    };
    if (ctx.state === "suspended") ctx.resume().then(doPlay).catch(() => {});
    else doPlay();
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
    if (cfg?.whimsyAffirmationToast !== false) {
      const msg = affirmations[Math.floor(Math.random() * affirmations.length)];
      setAffirmationToast(msg);
      clearTimeout(affirmationTimerRef.current);
      affirmationTimerRef.current = setTimeout(() => setAffirmationToast(null), 2500);
    }
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

      // Accrue elapsed time into ref (committed to state only on session end)
      sessionAccrualRef.current += dt;

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
            if (!n.listStats[n.currentList]) n.listStats[n.currentList] = defaultListStats();
            n.listStats[n.currentList].tasksCompleted += 1;
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
          if (configRef.current?.whimsyCompletionFlash !== false) {
            setCompletionFlash(true);
            setTimeout(() => setCompletionFlash(false), 450);
          }
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
        // Show celebration only when the list completed naturally (at least one task
        // completed and no "advance" side-effect, which would mean autoAdvance=false
        // paused mid-list rather than the whole list finishing).
        const listDoneNaturally =
          sideEffects.some((fx) => fx.type === "complete") &&
          !sideEffects.some((fx) => fx.type === "advance");
        // Commit accrued time to stats on session end
        const accrued = sessionAccrualRef.current;
        sessionAccrualRef.current = 0;
        patch((n) => {
          if (!n.listStats[n.currentList]) n.listStats[n.currentList] = defaultListStats();
          n.listStats[n.currentList].timeWorked += accrued;
          if (listDoneNaturally) {
            n.listStats[n.currentList].sessionsCompleted += 1;
            n.listStats[n.currentList].lastSession = new Date().toISOString();
          }
        });
        if (listDoneNaturally) {
          beepChord();
          if (configRef.current?.whimsyListComplete !== false) {
            setListComplete(true);
            clearTimeout(listCompleteTimerRef.current);
            listCompleteTimerRef.current = setTimeout(() => setListComplete(false), 4000);
          }
        }
      }
    }, 200);
  }

  function startTimer() {
    if (timerRef.current) return;
    setStartPulse(true);
    setTimeout(() => setStartPulse(false), 400);
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
    // Commit accrued time on pause
    if (sessionAccrualRef.current > 0) {
      const accrued = sessionAccrualRef.current;
      sessionAccrualRef.current = 0;
      const cl = stateRef.current.currentList;
      setState((s) => {
        const prev = s.listStats?.[cl] || defaultListStats();
        return { ...s, listStats: { ...s.listStats, [cl]: { ...prev, timeWorked: prev.timeWorked + accrued } } };
      });
    }
  }

  function skipTask() {
    const s = stateRef.current;
    const arr = s.lists[s.currentList] || [];
    const nxt = nextEnabledIndexFrom(arr, s.currentTaskIndex + 1);
    if (nxt === -1) { showIoStatus("error", "No next task."); return; }
    setSkipAnim({ from: s.currentTaskIndex, to: nxt });
    setTimeout(() => setSkipAnim(null), 280);
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
    } else {
      // Last task completed manually — commit stats + show celebration
      const accrued = sessionAccrualRef.current;
      sessionAccrualRef.current = 0;
      patch((n) => {
        if (!n.listStats[n.currentList]) n.listStats[n.currentList] = defaultListStats();
        n.listStats[n.currentList].tasksCompleted += 1;
        n.listStats[n.currentList].timeWorked += accrued;
        n.listStats[n.currentList].sessionsCompleted += 1;
        n.listStats[n.currentList].lastSession = new Date().toISOString();
      });
      announceComplete();
      beepChord();
      if (configRef.current?.whimsyListComplete !== false) {
        setListComplete(true);
        clearTimeout(listCompleteTimerRef.current);
        listCompleteTimerRef.current = setTimeout(() => setListComplete(false), 4000);
      }
    }
  }

  function restartTimer() {
    sessionAccrualRef.current = 0;
    pauseTimer();
    setListComplete(false);
    clearTimeout(listCompleteTimerRef.current);
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
              // Fix #1: sanitise the ytId attribute from XML at import time so the
              // unsanitised value never reaches localStorage or the BroadcastChannel.
              const sanitisedYtIdAttr = safeYtId(ytIdAttr);
              const meta = sanitisedYtIdAttr
                ? { ytId: sanitisedYtIdAttr, ytUrl: ytUrlAttr || (isYouTubeUrl(importedName) ? importedName : "") }
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
    {/* List-complete celebration overlay */}
    {listComplete && (
      <div
        className={`list-complete-overlay${state.dark ? " dark-mode" : ""}`}
        onClick={() => { setListComplete(false); clearTimeout(listCompleteTimerRef.current); }}
        role="dialog"
        aria-label="List complete"
      >
        <div className="list-complete-card">
          <i className="fas fa-star" />
          <p className="list-complete-title">List complete!</p>
          <p className="list-complete-sub">{state.currentList}</p>
        </div>
      </div>
    )}

    {/* Affirmation toast — shown on each task completion */}
    {affirmationToast && (
      <div className={`affirmation-toast${state.dark ? " dark-mode" : ""}`} aria-live="polite">
        <i className="fas fa-circle-check" /> {affirmationToast}
      </div>
    )}

    {/* Stats full-screen overlay */}
    {showStats && (
      <div className={`options-overlay${state.dark ? " dark-mode" : ""}`}>
        <div className="options-overlay-header">
          <span className="options-overlay-title">Stats</span>
          <button className="options-close-button" onClick={() => setShowStats(false)} aria-label="Close">
            <i className="fas fa-xmark" />
          </button>
        </div>
        <div className="options-overlay-body">
          <div className="stats-section">
            <p className="options-section-label">{state.currentList}</p>
            <div className="stats-grid">
              <div className="stat-card"><i className="fas fa-check-circle stat-card-icon" /><span className="stat-card-value">{currentListStats.tasksCompleted}</span><span className="stat-card-label">Tasks completed</span></div>
              <div className="stat-card"><i className="fas fa-clock stat-card-icon" /><span className="stat-card-value">{formatTimeWorked(currentListStats.timeWorked)}</span><span className="stat-card-label">Time worked</span></div>
              <div className="stat-card"><i className="fas fa-flag-checkered stat-card-icon" /><span className="stat-card-value">{currentListStats.sessionsCompleted}</span><span className="stat-card-label">Sessions</span></div>
              <div className="stat-card"><i className="fas fa-calendar stat-card-icon" /><span className="stat-card-value">{formatLastSession(currentListStats.lastSession)}</span><span className="stat-card-label">Last session</span></div>
            </div>
            <button className="stats-reset-btn" onClick={resetCurrentListStats}>Reset stats for this list</button>
          </div>
          <div className="stats-section">
            <p className="options-section-label">All lists combined</p>
            <div className="stats-grid">
              <div className="stat-card"><i className="fas fa-check-circle stat-card-icon" /><span className="stat-card-value">{allStats.tasksCompleted}</span><span className="stat-card-label">Tasks completed</span></div>
              <div className="stat-card"><i className="fas fa-clock stat-card-icon" /><span className="stat-card-value">{formatTimeWorked(allStats.timeWorked)}</span><span className="stat-card-label">Time worked</span></div>
              <div className="stat-card"><i className="fas fa-flag-checkered stat-card-icon" /><span className="stat-card-value">{allStats.sessionsCompleted}</span><span className="stat-card-label">Sessions</span></div>
            </div>
          </div>
        </div>
      </div>
    )}

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
            <h3><i className="fas fa-circle-play" /> Getting started</h3>
            <ul className="help-list">
              <li><b>Add a task:</b> Enter a name and duration, choose seconds / minutes / hours, then press <span className="kbd">+</span>.</li>
              <li><b>Set current task:</b> Click any task row to make it the active task.</li>
              <li><b>Enable / disable:</b> Use the toggle on each task to include or skip it during a run.</li>
              <li><b>Multiple lists:</b> Create separate lists (tabs) for different focus blocks, study sets, or circuits. Settings are saved per list.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-stopwatch" /> Timer controls</h3>
            <ul className="help-list">
              <li><b>Start / Pause:</b> Start or pause the timer for the current task.</li>
              <li><b>Skip:</b> Jump to the next enabled task; remaining time on the skipped task is unchanged.</li>
              <li><b>Complete:</b> Mark the current task done immediately and advance to the next.</li>
              <li><b>Restart:</b> Reset all tasks to their original durations and return to the first task.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-sliders" /> Settings</h3>
            <ul className="help-list">
              <li><b>Display:</b> Choose what the timer bar shows (task name, time, percentage, task count, ETA). Toggle compact task rows and the progress bar scope (whole list or current task).</li>
              <li><b>Timer:</b> Auto-start next task, count up or down, and set a warning highlight when time is low.</li>
              <li><b>Audio:</b> Enable a beep on task start. Set volume, tone (low / medium / high), and how many beeps play.</li>
              <li><b>Voice:</b> Enable text-to-speech. Choose a system voice and what gets announced (task name, duration, a custom message, or a random affirmation).</li>
              <li><b>General:</b> Set the default time unit for new tasks.</li>
              <li>Settings are saved per list — each list can have its own audio, voice, and display preferences.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-pen-to-square" /> Editing &amp; reordering</h3>
            <ul className="help-list">
              <li><b>Edit a task:</b> Open the <span className="dots">…</span> menu on a task and choose Edit. Change the name or total duration; remaining time resets when the duration changes.</li>
              <li><b>Delete a task:</b> Open the <span className="dots">…</span> menu and choose Delete.</li>
              <li><b>Reorder tasks:</b> Drag using the grip handle (<i className="fas fa-grip-vertical" />) on the left of each task row.</li>
              <li><b>List tabs:</b> Open the <span className="dots">…</span> on a tab to rename or delete the list. Drag tabs to rearrange their order.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fab fa-youtube" /> YouTube support</h3>
            <ul className="help-list">
              <li><b>Add a video task:</b> Paste any YouTube URL into the task name field. Supports youtube.com, youtu.be, Shorts, and embed links.</li>
              <li><b>Auto-play:</b> The embedded player starts automatically when that task becomes active and pauses when you switch tasks.</li>
              <li><b>Import:</b> YouTube URLs in imported XML files are auto-detected and embedded.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-file-import" /> Import / Export</h3>
            <ul className="help-list">
              <li><b>Export:</b> Downloads all your lists as an XML file, including task durations, remaining time, and YouTube metadata.</li>
              <li><b>Import:</b> Load an XML file to add lists and tasks. Existing lists with the same name are appended to, not replaced.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-circle-question" /> Tips</h3>
            <ul className="help-list">
              <li>Everything saves automatically in your browser — no account needed.</li>
              <li>Open TimeTallyToo in multiple tabs; changes sync instantly between them.</li>
              <li>Install as an app from your browser menu for a distraction-free experience.</li>
              <li>Disable tasks you want to skip without deleting them.</li>
            </ul>
          </div>
          <div className="help-footer">
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="help-footer-link">
              <i className="fab fa-github" /> woodtho/TimeTallyToo
            </a>
            <span className="help-footer-version">v{APP_VERSION}</span>
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
              <input type="number" id="warningThreshold" min="0" max="3600" step="1"
                value={config.warningThreshold ?? 0}
                onChange={(e) => patch((n) => { n.listConfigs[n.currentList].warningThreshold = Math.max(0, Number(e.target.value)); })} />
            </div>
          </div>

          <div className="options-section">
            <p className="options-section-label">Audio</p>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="beepCheckbox">Enable beep</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="beepCheckbox" className="enable-checkbox" checked={!!config.beepEnabled}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].beepEnabled = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="beepCheckbox"></label>
              </div>
            </div>
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
            <p className="options-section-label">Celebrations</p>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="whimsyAffirmationToast">Affirmation toast on task complete</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="whimsyAffirmationToast" className="enable-checkbox"
                  checked={config.whimsyAffirmationToast !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].whimsyAffirmationToast = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="whimsyAffirmationToast"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="whimsyCompletionFlash">Flash progress bar on task complete</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="whimsyCompletionFlash" className="enable-checkbox"
                  checked={config.whimsyCompletionFlash !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].whimsyCompletionFlash = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="whimsyCompletionFlash"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="whimsyRowPulse">Pulse active task row</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="whimsyRowPulse" className="enable-checkbox"
                  checked={config.whimsyRowPulse !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].whimsyRowPulse = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="whimsyRowPulse"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="whimsyStrikeThrough">Strike through completed tasks</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="whimsyStrikeThrough" className="enable-checkbox"
                  checked={config.whimsyStrikeThrough !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].whimsyStrikeThrough = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="whimsyStrikeThrough"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="whimsyListComplete">Show celebration on list complete</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="whimsyListComplete" className="enable-checkbox"
                  checked={config.whimsyListComplete !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].whimsyListComplete = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="whimsyListComplete"></label>
              </div>
            </div>
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="whimsyCompletionChord">Play chord on list complete</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="whimsyCompletionChord" className="enable-checkbox"
                  checked={config.whimsyCompletionChord !== false}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].whimsyCompletionChord = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="whimsyCompletionChord"></label>
              </div>
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
            <div className={`option-row option-row--toggle${state.dark ? " dark-mode" : ""}`}>
              <label htmlFor="ttsCheckbox">Enable text-to-speech</label>
              <div className="enable-checkbox-wrapper">
                <input type="checkbox" id="ttsCheckbox" className="enable-checkbox" checked={!!config.ttsEnabled}
                  onChange={(e) => patch((n) => { n.listConfigs[n.currentList].ttsEnabled = e.target.checked; })} />
                <label className="enable-checkbox-label" htmlFor="ttsCheckbox"></label>
              </div>
            </div>
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
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="github-button"
            title={`View on GitHub · v${APP_VERSION}`}
            aria-label="View source on GitHub"
          >
            <i className="fab fa-github" />
          </a>
          <button
            className="stats-button"
            title="Stats"
            aria-label="Open stats"
            onClick={() => { setMenuOpenTask(null); setMenuOpenTab(null); setShowStats((v) => !v); }}
          >
            <i className="fas fa-chart-bar" />
          </button>
          <button
            id="toggleOptionsButton"
            className="gear-button"
            title="Settings"
            aria-label="Open settings"
            onClick={() => { setMenuOpenTask(null); setMenuOpenTab(null); patch((n) => { n.showOptions = !n.showOptions; }); }}
          >
            <i className="fas fa-cog" />
          </button>
          <button
            id="toggleHelpButton"
            className="help-button"
            title="Help"
            aria-label="Open help"
            onClick={() => { setMenuOpenTask(null); setMenuOpenTab(null); patch((n) => { n.showHelp = !n.showHelp; }); }}
          >
            <i className="fas fa-question-circle" />
          </button>
          <button
            id="toggleDarkModeButton"
            className="dark-mode-button"
            title="Toggle dark mode"
            aria-label="Toggle dark mode"
            onClick={() => patch((n) => { n.dark = !n.dark; })}
          >
            <i className={`fas fa-${state.dark ? "sun" : "moon"}`} />
          </button>
        </div>
      </header>


      {/* Tabs + inline list creation */}
      <div className="tabs-scroll-wrapper">
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
                if (val) {
                  addList(val);
                  if (createListNameRef.current) createListNameRef.current.value = "";
                } else {
                  patch((n) => { n.isListCreating = false; });
                }
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
      </div>{/* end tabs-scroll-wrapper */}

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
            placeholder="Task name or YouTube URL"
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
          <select key={config.defaultTimeUnit} id="timeUnit" ref={timeUnitRef} aria-label="Time unit" defaultValue={config.defaultTimeUnit || "minutes"}>
            <option value="seconds">Seconds</option>
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
          </select>
          <button onClick={addTaskUI} title="Add task" aria-label="Add task">
            <i className="fas fa-plus" />
          </button>
        </div>
      </div>

      {/* Task list — Fix #9: extracted to TaskList component (React.memo) */}
      <TaskList
        tasks={tasks}
        config={config}
        dark={state.dark}
        isRunning={isRunning}
        currentTaskIndex={state.currentTaskIndex}
        currentList={state.currentList}
        editValues={editValues}
        menuOpenTask={menuOpenTask}
        listRef={listRef}
        newTaskId={newTaskId}
        skipAnim={skipAnim}
        droppedIndex={droppedIndex}
        editTask={editTask}
        removeTask={removeTask}
        patch={patch}
        setEditValues={setEditValues}
        setMenuOpenTask={setMenuOpenTask}
        onTaskPointerDown={onTaskPointerDown}
        onTaskPointerMove={onTaskPointerMove}
        onTaskPointerUp={onTaskPointerUp}
      />
      {tasks.length === 0 && (
        <div className="empty-state">
          <i className={`fas ${emptyState.icon}`} />
          <p>{emptyState.msg}</p>
        </div>
      )}

      {/* Sticky controls footer — Fix #9: extracted to TimerFooter component (React.memo) */}
      <TimerFooter
        config={config}
        dark={state.dark}
        isRunning={isRunning}
        isWarning={isWarning}
        isLastFive={isLastFive}
        startPulse={startPulse}
        completionFlash={completionFlash}
        currentTask={currentTask}
        progress={progress}
        timerDisplayTime={timerDisplayTime}
        enabledTaskCount={enabledTaskCount}
        currentEnabledPos={currentEnabledPos}
        startTimer={startTimer}
        pauseTimer={pauseTimer}
        skipTask={skipTask}
        completeEarly={completeEarly}
        restartList={restartTimer}
      />

      {/* Import / Export */}
      <div className="import-export">
        <div className="import-export-buttons">
          <button className="btn-export" onClick={exportTasksToXML} title="Export Tasks">
            <i className="fas fa-file-export" /> Export Tasks
          </button>
          {/* Fix #2: trigger via ref instead of document.getElementById */}
          <button id="importFileBttn" onClick={() => importFileRef.current?.click()} title="Import Tasks">
            <i className="fas fa-file-import" /> Import Tasks
          </button>
          <input
            ref={importFileRef}
            type="file"
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
        {/* Always-present aria-live region so screen readers announce IO status changes */}
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {ioStatus?.msg ?? ""}
        </div>
      </div>
    </div>
    </>
  );
}
