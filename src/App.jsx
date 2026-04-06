import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
// Fix #9: sub-components for render isolation (React.memo prevents re-renders
// on unrelated parent state changes, e.g. every 200ms timer tick).
import TimerFooter from "./components/TimerFooter";
import TaskList from "./components/TaskList";
import PipOverlay from "./components/PipOverlay";

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
  timeWorked: 0,        // cumulative seconds
  sessionsCompleted: 0,
  tasksSkipped: 0,      // times skip was pressed on this list
  lastSession: null,    // ISO 8601 datetime string
  firstSession: null,   // ISO 8601 datetime string — set once, never overwritten
  lastSessionDate: null,// YYYY-MM-DD for streak tracking
  longestSession: 0,    // seconds, per session
  currentStreak: 0,     // consecutive days with a session
  bestStreak: 0,        // all-time best consecutive days
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

/* Tiny stat-card used only in the stats overlay */
function SC({ icon, value, label, small }) {
  return (
    <div className="stat-card">
      <i className={`fas ${icon} stat-card-icon`} />
      <span className={`stat-card-value${small ? " stat-card-value--sm" : ""}`}>{value}</span>
      <span className="stat-card-label">{label}</span>
    </div>
  );
}

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
  const [tabMenuPos, setTabMenuPos] = useState(null);       // { top, right } for portal-rendered tab popover
  const [confirmDeleteList, setConfirmDeleteList] = useState(null);
  const [ioStatus, setIoStatus] = useState(null);           // { type: 'success'|'error', msg: string } | null
  const ioStatusTimerRef = useRef(null);
  const [isRunning, setIsRunning] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [expandedLists, setExpandedLists] = useState({});
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
  const addBtnRef = useRef(null);
  const createListNameRef = useRef(null);
  const timerRef = useRef(null);
  const audioCtxRef = useRef(null);
  const lastTick = useRef(null);
  const sessionAccrualRef = useRef(0); // accumulates elapsed seconds during a running session
  const draggedTabIndex = useRef(null);
  const bcRef = useRef(null);                               // BroadcastChannel ref
  const importFileRef = useRef(null); // Fix #2: replaces document.getElementById("importFile")
  const pipWindowRef = useRef(null);  // Document PiP window reference
  const pipRootRef = useRef(null);    // React root rendered inside the PiP window
  const [isPiPActive, setIsPiPActive] = useState(false);
  const canvasRef = useRef(null);     // canvas drawn into the Video PiP
  const videoRef = useRef(null);      // video element driving Video PiP
  const [isPiPVideoActive, setIsPiPVideoActive] = useState(false);
  const silentAudioRef = useRef(null); // keeps MediaSession alive on mobile
  const wakeLockRef = useRef(null);    // Screen Wake Lock — prevents auto-lock while timer runs
  const ytHeartbeatRef = useRef(null); // interval that keeps YouTube iframe playing under lock
  const pipDesiredPlayingRef = useRef(false); // true while the PiP canvas video should be playing
  const [pipError, setPipError] = useState(null); // user-visible PiP error toast

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

  /* Expand current list when stats panel opens */
  useEffect(() => {
    if (showStats) setExpandedLists({ [state.currentList]: true });
  }, [showStats]); // intentionally only reacts to open/close, not currentList changes

  /* Reset list delete confirmation when tab menu closes */
  useEffect(() => { setConfirmDeleteList(null); }, [menuOpenTab]);

  /* Keep stateRef current so event handlers always see the latest state */
  useEffect(() => { stateRef.current = state; }, [state]);
  /* Keep voicesRef current so timer callbacks never use stale closures */
  useEffect(() => { voicesRef.current = voices; }, [voices]);

  /* Keep YouTube in sync with page visibility (screen lock / app switch).
     Reality: Wake Lock API only prevents auto-lock while visible — it does NOT keep
     the page visible after the user manually locks the screen. So YouTube's iframe
     will see visibilitychange and auto-pause itself whenever the screen locks.
     Our mitigation is a heartbeat (see startYouTubeHeartbeat) that keeps firing
     playVideo postMessage every 2s while the timer is running; postMessage still
     reaches the cross-origin iframe even when the owning page is hidden.

     Additionally, Video PiP keeps the document "visible" from YouTube's perspective
     on Android Chrome (the spec requires the page stay active to drive PiP content),
     so opening PiP before locking the screen is the most reliable listen-on-lock path. */
  useEffect(() => {
    function onVisibility() {
      if (!timerRef.current) return;
      if (!document.hidden) {
        // Page became visible again — re-acquire wake lock and kick YouTube.
        requestWakeLock();
        playYouTubeIfAny(stateRef.current.currentTaskIndex);
      }
      // When page becomes hidden, we do nothing here — the heartbeat interval
      // continues to run in the background and repeatedly nudges the iframe.
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* Keep PiP overlays in sync with current timer state.
     Fix: previously had no deps → React re-ran this effect on every render
     (e.g. menu toggles, unrelated state). Now it only runs when values that
     actually affect the PiP visual change. */
  useEffect(() => {
    // Document PiP (desktop Chrome)
    if (isPiPActive && pipRootRef.current) {
      pipRootRef.current.render(
        <PipOverlay
          isRunning={isRunning}
          currentTask={currentTask}
          timerDisplayTime={timerDisplayTime}
          progress={progress}
          dark={state.dark}
          startTimer={startTimer}
          pauseTimer={pauseTimer}
        />
      );
    }
    // Video PiP canvas (Android / iOS)
    if (isPiPVideoActive && canvasRef.current) {
      drawTimerCanvas();
    }
  }, [
    isPiPActive, isPiPVideoActive,
    isRunning, currentTask, timerDisplayTime, progress, state.dark,
  ]);

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
      stopYouTubeHeartbeat();
      releaseWakeLock();
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
      tasksSkipped: all.reduce((a, s) => a + (s.tasksSkipped || 0), 0),
      bestStreak: all.reduce((a, s) => Math.max(a, s.bestStreak || 0), 0),
      longestSession: all.reduce((a, s) => Math.max(a, s.longestSession || 0), 0),
    };
  }, [state.listStats]);

  const mostActiveList = useMemo(() => {
    const entries = Object.entries(state.listStats || {});
    if (!entries.length) return "—";
    const best = entries.reduce((a, b) => (b[1].timeWorked || 0) > (a[1].timeWorked || 0) ? b : a);
    return best[1].timeWorked > 0 ? best[0] : "—";
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

  function formatStreak(days) {
    if (!days) return "—";
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  function formatAvgSession(timeWorked, sessions) {
    if (!sessions) return "—";
    return formatTimeWorked(timeWorked / sessions);
  }

  function formatLastSession(iso) {
    if (!iso) return "never";
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch { return "—"; }
  }

  function formatUsingSince(iso) {
    if (!iso) return "—";
    try {
      const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
      if (days === 0) return "today";
      if (days === 1) return "1 day";
      if (days < 30) return `${days} days`;
      const months = Math.floor(days / 30);
      return months === 1 ? "1 month" : `${months} months`;
    } catch { return "—"; }
  }

  function formatAvgTasks(tasksCompleted, sessionsCompleted) {
    if (!sessionsCompleted) return "—";
    return (tasksCompleted / sessionsCompleted).toFixed(1);
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
    if (!name || !amt || amt <= 0) {
      // Shake animation on the add button
      const btn = addBtnRef.current;
      if (btn) {
        btn.classList.remove("btn--rejected");
        void btn.offsetWidth; // reflow to restart animation on rapid double-tap
        btn.classList.add("btn--rejected");
        btn.addEventListener("animationend", () => btn.classList.remove("btn--rejected"), { once: true });
      }
      return;
    }
    const toSeconds = unit === "seconds" ? secs : unit === "minutes" ? mins : hours;
    const t = toSeconds(amt);
    const norm = normalizeTaskFromName(name, t);
    patch((n) => {
      n.lists[n.currentList].push(norm);
    });
    setNewTaskId(norm.id);
    setTimeout(() => setNewTaskId(null), 350);
    // Success feedback on button and input
    const btn = addBtnRef.current;
    if (btn) {
      btn.classList.remove("btn--added");
      void btn.offsetWidth;
      btn.classList.add("btn--added");
      btn.addEventListener("animationend", () => btn.classList.remove("btn--added"), { once: true });
    }
    const inp = taskNameRef.current;
    if (inp) {
      inp.classList.remove("input--confirmed");
      void inp.offsetWidth;
      inp.classList.add("input--confirmed");
      inp.addEventListener("animationend", () => inp.classList.remove("input--confirmed"), { once: true });
      inp.value = "";
    }
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

  function pauseCurrentYouTube() {
    // Target the current task's iframe directly by ID — more reliable than
    // querySelectorAll when only one iframe is ever in the DOM at a time.
    const s = stateRef.current;
    const iframe = document.getElementById(`yt-iframe-${s.currentList}__${s.currentTaskIndex}`);
    if (iframe) postToYouTubeIframe(iframe, "pauseVideo");
  }

  function playYouTubeIfAny(idx) {
    const key = `${stateRef.current.currentList}__${idx}`;
    const iframe = document.getElementById(`yt-iframe-${key}`);
    if (!iframe) return;
    postToYouTubeIframe(iframe, "playVideo");
  }

  /* Heartbeat: repeatedly re-issue playVideo to the current YouTube iframe.
     Why this exists: YouTube's iframe has its own visibilitychange listener
     (cross-origin — we can't suppress it) that auto-pauses playback when
     document.hidden becomes true (i.e. screen lock / app switch on mobile).
     The Screen Wake Lock API does NOT prevent this — it only prevents the
     OS auto-lock while the page is visible. So to achieve "listen on lock",
     we spam playVideo at a steady cadence. postMessage still crosses origins
     even while the owner document is hidden; YouTube responds and resumes.
     Idempotent when already playing, so the overhead is trivial. */
  function startYouTubeHeartbeat() {
    stopYouTubeHeartbeat();
    ytHeartbeatRef.current = setInterval(() => {
      if (!timerRef.current) return; // stop nudging once the timer is paused
      const s = stateRef.current;
      const task = (s.lists[s.currentList] || [])[s.currentTaskIndex];
      if (!task || !isYouTubeUrl(task.name)) return;
      playYouTubeIfAny(s.currentTaskIndex);
    }, 2000);
  }

  function stopYouTubeHeartbeat() {
    if (ytHeartbeatRef.current) {
      clearInterval(ytHeartbeatRef.current);
      ytHeartbeatRef.current = null;
    }
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
          // Update lock-screen / notification title for the new task
          if ("mediaSession" in navigator) {
            try {
              const cl = stateRef.current.currentList;
              navigator.mediaSession.metadata = new MediaMetadata({
                title: fx.task?.name && !fx.task.name.match(/^https?:\/\//) ? fx.task.name : "Timer running",
                artist: cl === "default" ? "TimeTallyToo" : cl,
                album: "TimeTallyToo",
              });
            } catch { /* ignore */ }
          }
        } else if (fx.type === "advance") {
          pauseAllYouTube();
        }
      }

      if (timerEnded) {
        clearInterval(timerRef.current);
        timerRef.current = null;
        pipDesiredPlayingRef.current = false;
        pauseAllYouTube();
        stopYouTubeHeartbeat();
        setIsRunning(false);
        releaseWakeLock();
        deactivateMediaSession();
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
            const now = new Date().toISOString();
            n.listStats[n.currentList].lastSession = now;
            if (!n.listStats[n.currentList].firstSession) n.listStats[n.currentList].firstSession = now;
            n.listStats[n.currentList].longestSession = Math.max(
              n.listStats[n.currentList].longestSession || 0, accrued
            );
            const today = new Date().toISOString().slice(0, 10);
            const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
            const prev = n.listStats[n.currentList].lastSessionDate;
            if (prev !== today) {
              n.listStats[n.currentList].currentStreak =
                prev === yesterday ? (n.listStats[n.currentList].currentStreak || 0) + 1 : 1;
              n.listStats[n.currentList].bestStreak = Math.max(
                n.listStats[n.currentList].bestStreak || 0,
                n.listStats[n.currentList].currentStreak
              );
              n.listStats[n.currentList].lastSessionDate = today;
            }
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
    requestWakeLock();
    startYouTubeHeartbeat();
    activateMediaSession(arr[startIndex]);
    // Resume canvas video if PiP is already open (e.g. user paused then resumed)
    pipDesiredPlayingRef.current = true;
    if (videoRef.current && document.pictureInPictureElement === videoRef.current && videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
    }
  }

  function pauseTimer() {
    if (!timerRef.current) return;
    clearInterval(timerRef.current);
    timerRef.current = null; // null BEFORE pausing video so onPause guard sees timer is stopped
    pipDesiredPlayingRef.current = false;
    setIsRunning(false);
    pauseCurrentYouTube();
    pauseAllYouTube(); // belt-and-suspenders
    stopYouTubeHeartbeat();
    releaseWakeLock();
    deactivateMediaSession();
    // Pause canvas video so PiP shows the correct paused state
    if (videoRef.current && document.pictureInPictureElement === videoRef.current) {
      videoRef.current.pause();
    }
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

  /* ---- Video PiP — canvas-based floating mini-player (Android / iOS) ----
     Rendered at 320×180 (16:9); browsers scale up for crispness.  Palette mirrors
     public/styles.css exactly: .progress-bar (#4caf50 light / #76c7c0 dark),
     .timer-remaining (#2196f3 light / #90caf9 dark), .timer-task-name (#333/#eee),
     and .timer-section background (#fafafa/#2a2a2a). */
  function drawTimerCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const dark = stateRef.current.dark;

    // Design tokens copied from public/styles.css
    const bg          = dark ? "#1e1e1e" : "#f5f5f5";      // .controls-footer
    const sectionBg   = dark ? "#2a2a2a" : "#fafafa";      // .timer-section
    const borderColor = dark ? "#444"    : "#ccc";
    const trackColor  = dark ? "#333"    : "#ddd";         // .progress-container
    const barRunning  = dark ? "#76c7c0" : "#4caf50";      // .progress-bar
    const barPaused   = dark ? "#555"    : "#bbb";
    const timerColor  = dark ? "#90caf9" : "#2196f3";      // .timer-remaining
    const labelColor  = dark ? "#eee"    : "#333";         // .timer-task-name
    const subtleColor = dark ? "#999"    : "#777";
    const ytColor     = dark ? "#ff5252" : "#c62828";

    // Outer background
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Card with drop shadow to echo the main app's floating footer
    const PAD = 10;
    const cardX = PAD, cardY = PAD, cardW = W - PAD * 2, cardH = H - PAD * 2;
    ctx.save();
    ctx.shadowColor = dark ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.18)";
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = sectionBg;
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 10);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(cardX + 0.5, cardY + 0.5, cardW - 1, cardH - 1, 10);
    ctx.stroke();

    // Progress bar — 12px high, rounded, pinned to top of card, clipped inside corners
    const BAR_X = cardX + 12;
    const BAR_Y = cardY + 14;
    const BAR_W = cardW - 24;
    const BAR_H = 6;
    const pct = Math.min(Math.max(progress, 0), 100) / 100;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(BAR_X, BAR_Y, BAR_W, BAR_H, 3);
    ctx.clip();
    ctx.fillStyle = trackColor;
    ctx.fillRect(BAR_X, BAR_Y, BAR_W, BAR_H);
    ctx.fillStyle = isRunning ? barRunning : barPaused;
    ctx.fillRect(BAR_X, BAR_Y, BAR_W * pct, BAR_H);
    ctx.restore();

    // Task name row (bold 13px — matches .timer-task-name)
    const rawName = currentTask?.name ?? "";
    const isYT = !!rawName.match(/^https?:\/\//);
    const TEXT_X = cardX + 14;
    const TASK_Y = BAR_Y + BAR_H + 10;
    ctx.font = "bold 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.textBaseline = "top";
    if (isYT) {
      const badge = "▶ YouTube";
      const metrics = ctx.measureText(badge);
      const bw = metrics.width + 14;
      ctx.fillStyle = ytColor;
      ctx.beginPath();
      ctx.roundRect(TEXT_X, TASK_Y, bw, 20, 10);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(badge, TEXT_X + 7, TASK_Y + 4);
    } else {
      ctx.fillStyle = labelColor;
      let label = rawName || "Ready";
      const maxW = cardW - 28;
      while (label.length > 1 && ctx.measureText(label + "…").width > maxW) label = label.slice(0, -1);
      ctx.fillText(label === (rawName || "Ready") ? label : label + "…", TEXT_X, TASK_Y + 2);
    }

    // Timer readout — 'Courier New' monospace; size scales with card height
    const timerStr = formatHMS(timerDisplayTime);
    const TIMER_FONT_PX = Math.min(52, Math.round(cardH * 0.42));
    ctx.font = `bold ${TIMER_FONT_PX}px 'Courier New', Courier, monospace`;
    ctx.fillStyle = isRunning ? timerColor : subtleColor;
    ctx.textBaseline = "middle";
    // Right-align vertically, with a little optical offset downwards
    const TIMER_Y = cardY + cardH * 0.62;
    ctx.fillText(timerStr, TEXT_X, TIMER_Y);

    // Percent label (bottom-right, mirrors .timer-percent)
    ctx.font = "600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.fillStyle = subtleColor;
    ctx.textBaseline = "alphabetic";
    const pctStr = `${Math.round(progress)}%`;
    const pctW = ctx.measureText(pctStr).width;
    ctx.fillText(pctStr, cardX + cardW - pctW - 14, cardY + cardH - 14);

    // Paused chip (bottom-left)
    if (!isRunning) {
      ctx.font = "600 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      ctx.fillStyle = subtleColor;
      ctx.textBaseline = "alphabetic";
      ctx.fillText("⏸ Paused", cardX + 14, cardY + cardH - 14);
    }
  }

  async function openVideoPiP() {
    if (!document.pictureInPictureEnabled) {
      showPipError("Picture-in-picture is not available on this browser.");
      return;
    }
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
      return;
    }
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    // Draw the first frame BEFORE capturing the stream, otherwise some browsers
    // hand us a stream whose first frame is blank and PiP shows a black flash.
    drawTimerCanvas();

    try {
      // Always refresh the srcObject when any existing track has ended. The
      // previous "reuse if any live" check could keep a half-dead stream.
      const tracks = video.srcObject?.getTracks?.() || [];
      const allLive = tracks.length > 0 && tracks.every((t) => t.readyState === "live");
      if (!allLive) {
        // Stop any stale tracks before replacing so the GC can reclaim them.
        tracks.forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
        video.srcObject = canvas.captureStream(4);
        video.muted = true;
      }
      if (video.paused) await video.play();
      await video.requestPictureInPicture();
      setIsPiPVideoActive(true);
      video.addEventListener("leavepictureinpicture", () => {
        setIsPiPVideoActive(false);
        pipDesiredPlayingRef.current = false;
      }, { once: true });

      // Register Media Session handlers now so the PiP play/pause button
      // works even before the timer has been started for the first time.
      if ("mediaSession" in navigator) {
        try {
          navigator.mediaSession.setActionHandler("play",      () => startTimer());
          navigator.mediaSession.setActionHandler("pause",     () => pauseTimer());
          navigator.mediaSession.setActionHandler("nexttrack", () => skipTask());
        } catch { /* ignore */ }
      }

      // Reflect current timer state in the PiP control (play vs pause button).
      pipDesiredPlayingRef.current = !!timerRef.current;
      if (!timerRef.current) {
        video.pause();
      }
    } catch (err) {
      // Common reasons: user gesture requirement, iOS restrictions, or hardware denial.
      const msg = err?.name === "NotAllowedError"
        ? "Picture-in-picture was blocked. Try tapping the button again."
        : "Couldn't open the mini player on this device.";
      showPipError(msg);
    }
  }

  function showPipError(msg) {
    setPipError(msg);
    setTimeout(() => setPipError((cur) => (cur === msg ? null : cur)), 3200);
  }

  /* ---- Screen Wake Lock ----
     Prevents the OS *auto*-lock while the user is running a timer (so an
     unattended task doesn't dim mid-session). Does NOT prevent a manual
     power-button lock, and is auto-released by the browser whenever the
     page is backgrounded — so this is a convenience, not the mechanism
     that keeps YouTube audio playing under lock. That job belongs to the
     heartbeat in startYouTubeHeartbeat(). */
  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      // Release any stale lock first
      if (wakeLockRef.current) {
        try { await wakeLockRef.current.release(); } catch { /* ignore */ }
        wakeLockRef.current = null;
      }
      const lock = await navigator.wakeLock.request("screen");
      wakeLockRef.current = lock;
      lock.addEventListener("release", () => {
        // System released the lock (e.g. tab backgrounded); clear our ref
        if (wakeLockRef.current === lock) wakeLockRef.current = null;
      });
    } catch { /* denied — low battery, or not supported */ }
  }

  function releaseWakeLock() {
    if (!wakeLockRef.current) return;
    try { wakeLockRef.current.release(); } catch { /* ignore */ }
    wakeLockRef.current = null;
  }

  /* ---- Media Session (Android/iOS lock-screen & notification controls) ---- */
  function _getSilentAudio() {
    if (silentAudioRef.current) return silentAudioRef.current;
    // Minimal 1-sample looping WAV to keep the MediaSession notification alive
    const buf = new ArrayBuffer(46);
    const v = new DataView(buf);
    const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    s(0,"RIFF"); v.setUint32(4,38,true); s(8,"WAVE"); s(12,"fmt ");
    v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
    v.setUint32(24,8000,true); v.setUint32(28,16000,true);
    v.setUint16(32,2,true); v.setUint16(34,16,true);
    s(36,"data"); v.setUint32(40,2,true); v.setInt16(44,0,true);
    const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    const audio = new Audio(url);
    audio.loop = true;
    audio.volume = 0.01; // near-silent but loud enough for Android to treat as active audio
    silentAudioRef.current = audio;
    return audio;
  }

  function activateMediaSession(task) {
    if (!("mediaSession" in navigator)) return;
    try {
      _getSilentAudio().play().catch(() => {});
      const cl = stateRef.current.currentList;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: task?.name && !task.name.match(/^https?:\/\//) ? task.name : "Timer running",
        artist: cl === "default" ? "TimeTallyToo" : cl,
        album: "TimeTallyToo",
      });
      navigator.mediaSession.playbackState = "playing";
      navigator.mediaSession.setActionHandler("play", () => startTimer());
      navigator.mediaSession.setActionHandler("pause", () => pauseTimer());
      navigator.mediaSession.setActionHandler("nexttrack", () => skipTask());
    } catch { /* MediaSession not available in this context */ }
  }

  function deactivateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      silentAudioRef.current?.pause();
      navigator.mediaSession.playbackState = "paused";
    } catch { /* ignore */ }
  }

  async function openPiP() {
    if (!("documentPictureInPicture" in window)) {
      showPipError("Mini player is not supported in this browser.");
      return;
    }
    // Toggle: close if already open
    if (pipWindowRef.current) {
      pipWindowRef.current.close();
      return;
    }
    try {
      const pipWin = await window.documentPictureInPicture.requestWindow({ width: 260, height: 220 });
      pipWindowRef.current = pipWin;
      setIsPiPActive(true);

      // Clean up when PiP window is closed by the user
      pipWin.addEventListener("pagehide", () => {
        pipWindowRef.current = null;
        pipRootRef.current = null;
        setIsPiPActive(false);
      });

      // Match the main app background to avoid a white flash before first render
      const bg = stateRef.current.dark ? "#1e1e1e" : "#f5f5f5";
      pipWin.document.documentElement.style.cssText = `margin:0;padding:0;height:100%;overflow:hidden;background:${bg};`;
      pipWin.document.body.style.cssText = `margin:0;padding:0;height:100%;overflow:hidden;background:${bg};`;

      // Mount a React root in the PiP window
      const container = pipWin.document.createElement("div");
      container.style.height = "100%";
      pipWin.document.body.appendChild(container);
      pipRootRef.current = createRoot(container);
    } catch (err) {
      const msg = err?.name === "NotAllowedError"
        ? "Mini player was blocked. Try tapping the button again."
        : "Couldn't open the mini player.";
      showPipError(msg);
    }
  }

  function skipTask() {
    const s = stateRef.current;
    const arr = s.lists[s.currentList] || [];
    const nxt = nextEnabledIndexFrom(arr, s.currentTaskIndex + 1);
    if (nxt === -1) { completeEarly(); return; }
    setSkipAnim({ from: s.currentTaskIndex, to: nxt });
    setTimeout(() => setSkipAnim(null), 280);
    const wasRunning = !!timerRef.current;
    pauseAllYouTube();
    beep();
    if (wasRunning) {
      lastTick.current = performance.now();
      patch((n) => { n.currentTaskIndex = nxt; if (!n.listStats[n.currentList]) n.listStats[n.currentList] = defaultListStats(); n.listStats[n.currentList].tasksSkipped += 1; });
      playYouTubeIfAny(nxt);
    } else {
      patch((n) => { n.currentTaskIndex = nxt; if (!n.listStats[n.currentList]) n.listStats[n.currentList] = defaultListStats(); n.listStats[n.currentList].tasksSkipped += 1; });
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
        const now2 = new Date().toISOString();
        n.listStats[n.currentList].lastSession = now2;
        if (!n.listStats[n.currentList].firstSession) n.listStats[n.currentList].firstSession = now2;
        n.listStats[n.currentList].longestSession = Math.max(
          n.listStats[n.currentList].longestSession || 0, accrued
        );
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const prev = n.listStats[n.currentList].lastSessionDate;
        if (prev !== today) {
          n.listStats[n.currentList].currentStreak =
            prev === yesterday ? (n.listStats[n.currentList].currentStreak || 0) + 1 : 1;
          n.listStats[n.currentList].bestStreak = Math.max(
            n.listStats[n.currentList].bestStreak || 0,
            n.listStats[n.currentList].currentStreak
          );
          n.listStats[n.currentList].lastSessionDate = today;
        }
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
    {/* Tab list action popover — rendered as a portal to escape the tabs-container
        overflow:auto clipping context that would hide it on mobile. */}
    {menuOpenTab !== null && tabMenuPos && createPortal(
      <div
        data-menu-root="true"
        className={`menu-popover${state.dark ? " dark-mode" : ""}`}
        style={{ position: "fixed", top: tabMenuPos.top, right: tabMenuPos.right, zIndex: 9999 }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="menu-item"
          onClick={() => {
            setRenamingTab(menuOpenTab);
            setRenamingTabValue(menuOpenTab);
            setMenuOpenTab(null);
          }}
        >
          <i className="fas fa-pen" /> Rename
        </button>
        {confirmDeleteList === menuOpenTab ? (
          <button
            className="menu-item menu-danger menu-danger--confirm"
            onClick={() => { deleteList(menuOpenTab); setMenuOpenTab(null); }}
          >
            <i className="fas fa-exclamation-triangle" /> Confirm delete?
          </button>
        ) : (
          <button
            className="menu-item menu-danger"
            onClick={() => setConfirmDeleteList(menuOpenTab)}
          >
            <i className="fas fa-trash" /> Delete
          </button>
        )}
      </div>,
      document.body
    )}
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
        <div className="options-overlay-body stats-overlay-body">

          {/* ── Global hero block ─────────────────────── */}
          <div className={`stats-global-block${state.dark ? " dark-mode" : ""}`}>
            <p className="stats-block-label">
              Overall
              <span className="stats-list-count">{state.listOrder.length} list{state.listOrder.length !== 1 ? "s" : ""}</span>
            </p>
            <div className="stats-hero">
              <div className="stat-hero-item">
                <span className="stat-hero-value">{allStats.tasksCompleted}</span>
                <span className="stat-hero-label">Tasks done</span>
              </div>
              <div className="stat-hero-item">
                <span className="stat-hero-value">{formatTimeWorked(allStats.timeWorked)}</span>
                <span className="stat-hero-label">Time worked</span>
              </div>
              <div className="stat-hero-item">
                <span className="stat-hero-value">{allStats.sessionsCompleted}</span>
                <span className="stat-hero-label">Sessions</span>
              </div>
            </div>
            <div className="stats-grid stats-grid--3">
              <SC icon="fa-hourglass-half" value={formatAvgSession(allStats.timeWorked, allStats.sessionsCompleted)} label="Avg session" />
              <SC icon="fa-tasks"          value={formatAvgTasks(allStats.tasksCompleted, allStats.sessionsCompleted)} label="Avg tasks" />
              <SC icon="fa-forward"        value={allStats.tasksSkipped} label="Skipped" />
              <SC icon="fa-trophy"         value={formatTimeWorked(allStats.longestSession)} label="Longest" />
              <SC icon="fa-star"           value={formatStreak(allStats.bestStreak)} label="Best streak" />
              <SC icon="fa-medal"          value={mostActiveList} label="Most active" small />
            </div>
          </div>

          {/* ── Per-list accordion ────────────────────── */}
          <p className="stats-block-label stats-block-label--section">By list</p>
          <div className="stats-accordion">
            {state.listOrder.map((listName) => {
              const ls = { ...defaultListStats(), ...(state.listStats?.[listName] || {}) };
              const listTaskCount = (state.lists[listName] || []).length;
              const isOpen = !!expandedLists[listName];
              return (
                <div key={listName} className={`stats-accordion-item${state.dark ? " dark-mode" : ""}${listName === state.currentList ? " is-current" : ""}`}>
                  <button
                    className={`stats-accordion-header${isOpen ? " is-open" : ""}`}
                    onClick={() => setExpandedLists(prev => ({ ...prev, [listName]: !prev[listName] }))}
                    aria-expanded={isOpen}
                  >
                    <span className="stats-accordion-name">{listName}</span>
                    <span className="stats-accordion-meta">{formatTimeWorked(ls.timeWorked)} · {ls.sessionsCompleted} session{ls.sessionsCompleted !== 1 ? "s" : ""}</span>
                    <i className="fas fa-chevron-down stats-accordion-chevron" />
                  </button>
                  <div className={`stats-accordion-body${isOpen ? " is-open" : ""}`}>
                    <div className="stats-accordion-body-inner">
                      <div className="stats-grid stats-grid--3 stats-accordion-grid">
                        <SC icon="fa-check-circle"   value={ls.tasksCompleted} label="Completed" />
                        <SC icon="fa-clock"          value={formatTimeWorked(ls.timeWorked)} label="Time worked" />
                        <SC icon="fa-flag-checkered" value={ls.sessionsCompleted} label="Sessions" />
                        <SC icon="fa-hourglass-half" value={formatAvgSession(ls.timeWorked, ls.sessionsCompleted)} label="Avg session" />
                        <SC icon="fa-tasks"          value={formatAvgTasks(ls.tasksCompleted, ls.sessionsCompleted)} label="Avg tasks" />
                        <SC icon="fa-forward"        value={ls.tasksSkipped} label="Skipped" />
                        <SC icon="fa-trophy"         value={formatTimeWorked(ls.longestSession)} label="Longest" />
                        <SC icon="fa-fire"           value={formatStreak(ls.currentStreak)} label="Streak" />
                        <SC icon="fa-star"           value={formatStreak(ls.bestStreak)} label="Best streak" />
                        <SC icon="fa-seedling"       value={formatUsingSince(ls.firstSession)} label="Using for" />
                        <SC icon="fa-list-ul"        value={listTaskCount} label="Tasks" />
                        <SC icon="fa-calendar"       value={formatLastSession(ls.lastSession)} label="Last session" small />
                      </div>
                      <div className="stats-accordion-footer">
                        <button
                          className="stats-reset-btn"
                          onClick={() => patch((n) => { n.listStats[listName] = defaultListStats(); })}
                        >
                          Reset stats for this list
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
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
                onClick={(e) => {
                  e.stopPropagation();
                  if (menuOpenTab === name) {
                    setMenuOpenTab(null);
                  } else {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTabMenuPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
                    setMenuOpenTab(name);
                  }
                }}
              >
                <i className="fa fa-ellipsis-h" />
              </button>
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
          <button ref={addBtnRef} onClick={addTaskUI} title="Add task" aria-label="Add task">
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
        openPiP={openPiP}
        isPiPActive={isPiPActive}
        openVideoPiP={openVideoPiP}
        isPiPVideoActive={isPiPVideoActive}
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

    {/* PiP error toast (user-gesture denials, unsupported browsers, etc.) */}
    {pipError && (
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          left: "50%",
          bottom: "calc(env(safe-area-inset-bottom, 0px) + 96px)",
          transform: "translateX(-50%)",
          background: state.dark ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.98)",
          color: state.dark ? "#eee" : "#333",
          border: `1px solid ${state.dark ? "#444" : "#ccc"}`,
          borderRadius: 10,
          padding: "10px 14px",
          fontSize: 13,
          fontWeight: 500,
          maxWidth: "86vw",
          boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
          zIndex: 2000,
          pointerEvents: "none",
        }}
      >
        {pipError}
      </div>
    )}

    {/* Hidden canvas + video used for Video PiP (Android / iOS).
        Canvas is 320×180 (16:9) so text is crisper when the browser scales PiP up. */}
    <canvas ref={canvasRef} width={320} height={180}
      style={{ position: "fixed", left: "-9999px", top: "-9999px", pointerEvents: "none" }}
      aria-hidden="true"
    />
    <video
      ref={videoRef}
      muted
      playsInline
      onPause={(e) => {
        // Resume only when the app wants the video playing (i.e. the timer is running).
        // pipDesiredPlayingRef is set explicitly by startTimer/pauseTimer so this doesn't
        // rely on the subtle ordering of timerRef = null vs. video.pause().
        const hasLiveTrack = e.target.srcObject?.getTracks().some((t) => t.readyState === "live");
        if (hasLiveTrack && pipDesiredPlayingRef.current && document.pictureInPictureElement === e.target) {
          e.target.play().catch(() => {});
        }
      }}
      style={{ position: "fixed", left: "-9999px", top: "-9999px", width: 1, height: 1 }}
      aria-hidden="true"
    />
    </>
  );
}
