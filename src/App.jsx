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

// First-run example list — a structured workday with 5 deep-work blocks,
// real breaks, lunch, admin time, and a shutdown ritual. Total: 6h 30m.
// Only seeded for users with no existing localStorage (loadState short-circuits
// to this when LS_KEY is missing).
const EXAMPLE_LIST_NAME = "Workday";
const exampleWorkdayTasks = () => {
  const mk = (name, secs) => ({
    id: crypto.randomUUID(),
    name,
    time: secs,
    remaining: secs,
    enabled: true,
    editing: false,
  });
  return [
    mk("Morning intention & plan today's wins",   10 * 60),
    mk("Deep work — block 1",                     50 * 60),
    mk("Stretch & water",                         10 * 60),
    mk("Deep work — block 2",                     50 * 60),
    mk("Coffee & email triage",                   20 * 60),
    mk("Deep work — block 3",                     50 * 60),
    mk("Lunch & walk away",                       45 * 60),
    mk("Admin & messages",                        30 * 60),
    mk("Deep work — block 4",                     50 * 60),
    mk("Short break",                             10 * 60),
    mk("Deep work — block 5",                     50 * 60),
    mk("Shutdown ritual — review & plan tomorrow", 15 * 60),
  ];
};

const defaultState = () => ({
  lists: { [EXAMPLE_LIST_NAME]: exampleWorkdayTasks() },
  listOrder: [EXAMPLE_LIST_NAME],
  currentList: EXAMPLE_LIST_NAME,
  currentTaskIndex: 0,
  listConfigs: { [EXAMPLE_LIST_NAME]: defaultConfig() },
  listStats: { [EXAMPLE_LIST_NAME]: defaultListStats() },
  dark: true,
  showHelp: false,
  showOptions: false,
  isListCreating: false,
  tutorialSeen: false,
});

// First-run tutorial steps. Plain content; no anchors needed because the
// overlay is a centered/bottom-sheet card, not a per-element coachmark.
// `highlight` keys map to a CSS rule that adds a glow ring to the matching
// region of the app while that step is active.
const TUTORIAL_STEPS = [
  {
    icon: "fa-rocket",
    title: "Welcome to TimeTally",
    body: "A tab-based timer for stacking focus sessions, breaks, study blocks — anything you can put on a list.",
    highlight: null,
  },
  {
    icon: "fa-list-check",
    title: "Your Workday list",
    body: "We loaded a structured 6.5-hour workday: 5 deep-work blocks, real breaks, lunch, admin time, and a shutdown ritual. Tap a task to make it active, drag to reorder, or use the menu to edit times.",
    highlight: "tasks",
  },
  {
    icon: "fa-folder-tree",
    title: "Tabs are independent lists",
    body: "Each tab has its own tasks, sounds, and TTS settings. Tap + to add a new list — try a workout, a study session, or a daily routine.",
    highlight: "tabs",
  },
  {
    icon: "fa-play",
    title: "Timer controls",
    body: "Start, pause, skip, complete early, or restart from the footer. Picture-in-Picture keeps the timer visible when you switch apps or lock your screen.",
    highlight: "footer",
  },
  {
    icon: "fa-chart-line",
    title: "Stats & sharing",
    body: "Tap the chart icon to see your sessions, streaks, and time worked. Hit Share on any list to get an Instagram-ready card.",
    highlight: "stats",
  },
  {
    icon: "fa-gear",
    title: "Customize everything",
    body: "Settings tunes beeps, TTS voices, dark mode, and more. Help has the full guide. You can reopen this tutorial from the Help page anytime.",
    highlight: "header",
  },
];

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
      // Existing users never auto-see the tutorial — only true first-run users
      // (the !raw branch above) start with tutorialSeen: false.
      tutorialSeen: parsed.tutorialSeen ?? true,
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
    tutorialSeen: state.tutorialSeen,
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
  const [showDataPage, setShowDataPage] = useState(false);  // full-page Import/Export overlay
  const [isRunning, setIsRunning] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [expandedLists, setExpandedLists] = useState({});
  // Share-card modal: { scope: "overall" | listName }
  const [shareTarget, setShareTarget] = useState(null);
  // First-run tutorial — visibility is component-local, but `tutorialSeen`
  // lives in persistent state. Initialized below in a one-shot mount effect.
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const shareCanvasRef = useRef(null);
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
  const easterTapsRef = useRef({ count: 0, last: 0 }); // hidden tap counter on stats hero
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
     No deps array on purpose: currentTask / progress / timerDisplayTime are
     all `const` declarations later in the component body, so referencing them
     in a deps array here would hit the temporal dead zone and throw at render
     time. Re-running on every App render is cheap (just a React render into
     the PiP window + a 2D canvas paint) and keeps the PiP perfectly in sync. */
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
  });

  /* Repaint share-card canvas whenever target / theme / stats change. */
  useEffect(() => {
    if (!shareTarget) return;
    drawShareCard(shareCanvasRef.current, shareTarget);
  }, [shareTarget, state.dark, state.listStats, state.listOrder, state.lists]);

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

  /* First-run tutorial auto-open. Reads tutorialSeen from the loaded state once
     on mount; no deps so it never re-fires after the user dismisses it. */
  useEffect(() => {
    if (!stateRef.current.tutorialSeen) {
      setTutorialStep(0);
      setShowTutorial(true);
    }
  }, []);

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

  /* ───────────────────────── Share-card image generation ─────────────────────────
     Renders a 1080×1350 portrait Instagram-friendly card from a stats target
     (either "overall" or a list name). Drawing is a pure function of inputs +
     theme, so calling this in an effect when shareTarget changes produces a
     stable preview the user can download or hand to navigator.share().
  */
  function _shareStatsForTarget(target) {
    // Returns a normalised stats record for whichever scope was selected
    if (target === "overall") {
      const headline = "All Lists";
      const sub = `${state.listOrder.length} list${state.listOrder.length !== 1 ? "s" : ""}`;
      return { headline, sub, ...allStats };
    }
    const ls = { ...defaultListStats(), ...(state.listStats?.[target] || {}) };
    const taskCount = (state.lists[target] || []).length;
    return { headline: target, sub: `${taskCount} task${taskCount !== 1 ? "s" : ""}`, ...ls };
  }

  function drawShareCard(canvas, target) {
    if (!canvas) return;
    const W = 1080, H = 1350;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const dark = !!stateRef.current.dark;
    const data = _shareStatsForTarget(target);

    // ── Palette ────────────────────────────────────────────────
    const bgTop      = dark ? "#0f1922" : "#e3f2fd";
    const bgBot      = dark ? "#1e3a5f" : "#bbdefb";
    const card       = dark ? "#1e1e1e" : "#ffffff";
    const cardBorder = dark ? "#2f2f2f" : "#e0e0e0";
    const accent     = "#2196f3";
    const accentDim  = dark ? "#90caf9" : "#1976d2";
    const text       = dark ? "#f0f0f0" : "#212121";
    const textSub    = dark ? "#bbbbbb" : "#666666";
    const tileBg     = dark ? "#2a2a2a" : "#f5f7fa";
    const tileBorder = dark ? "#3a3a3c" : "#e6e9ef";

    // ── Background gradient ────────────────────────────────────
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, bgTop);
    grad.addColorStop(1, bgBot);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Decorative blurry circles for visual interest
    ctx.save();
    ctx.globalAlpha = dark ? 0.12 : 0.18;
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(W * 0.85, H * 0.12, 260, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(W * 0.10, H * 0.92, 320, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // ── Brand strip (top) ──────────────────────────────────────
    ctx.fillStyle = text;
    ctx.font = "700 44px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    // Brand mark — small blue rounded square + wordmark, like an app icon
    const brandX = 80, brandY = 110;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(brandX, brandY - 30, 60, 60, 14);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 36px 'Courier New', Courier, monospace";
    ctx.textAlign = "center";
    ctx.fillText("T", brandX + 30, brandY + 2);

    ctx.fillStyle = text;
    ctx.font = "800 42px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("TimeTally", brandX + 80, brandY);

    // Date in top right
    const dateStr = new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    ctx.font = "500 26px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.fillStyle = textSub;
    ctx.textAlign = "right";
    ctx.fillText(dateStr, W - 80, brandY);

    // ── Main card ──────────────────────────────────────────────
    const cardX = 60, cardY = 200, cardW = W - 120, cardH = 1020;
    ctx.save();
    ctx.shadowColor = dark ? "rgba(0,0,0,0.55)" : "rgba(33, 150, 243, 0.18)";
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = card;
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 28);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = cardBorder;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(cardX + 1, cardY + 1, cardW - 2, cardH - 2, 28);
    ctx.stroke();

    // Card eyebrow + title
    ctx.fillStyle = accent;
    ctx.font = "700 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("FOCUS STATS", W / 2, cardY + 70);

    // Headline (list name) — auto-shrink if too long
    let headlineSize = 76;
    ctx.font = `800 ${headlineSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
    while (ctx.measureText(data.headline).width > cardW - 120 && headlineSize > 36) {
      headlineSize -= 4;
      ctx.font = `800 ${headlineSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
    }
    ctx.fillStyle = text;
    ctx.fillText(data.headline, W / 2, cardY + 150);

    // Sub-line
    ctx.fillStyle = textSub;
    ctx.font = "500 28px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.fillText(data.sub, W / 2, cardY + 195);

    // Divider
    ctx.strokeStyle = cardBorder;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cardX + 80, cardY + 230);
    ctx.lineTo(cardX + cardW - 80, cardY + 230);
    ctx.stroke();

    // ── Hero metric: Time worked ───────────────────────────────
    const timeStr = _shareFormatTime(data.timeWorked || 0);
    ctx.fillStyle = textSub;
    ctx.font = "600 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("TIME FOCUSED", W / 2, cardY + 290);

    ctx.fillStyle = accentDim;
    ctx.font = "800 130px 'Courier New', Courier, monospace";
    ctx.fillText(timeStr, W / 2, cardY + 420);

    // ── 2×2 stat tiles ─────────────────────────────────────────
    const tileGapX = 30;
    const tileGapY = 30;
    const tilesAreaY = cardY + 480;
    const tilesAreaW = cardW - 100;
    const tileW = (tilesAreaW - tileGapX) / 2;
    const tileH = 200;
    const tilesX = cardX + 50;

    const tiles = [
      { label: "Tasks done",  value: String(data.tasksCompleted || 0) },
      { label: "Sessions",    value: String(data.sessionsCompleted || 0) },
      { label: "Best streak", value: (data.bestStreak ? `${data.bestStreak}d` : "—") },
      { label: "Longest",     value: _shareFormatTimeShort(data.longestSession || 0) },
    ];

    tiles.forEach((tile, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const tx = tilesX + col * (tileW + tileGapX);
      const ty = tilesAreaY + row * (tileH + tileGapY);

      // Tile bg
      ctx.fillStyle = tileBg;
      ctx.beginPath();
      ctx.roundRect(tx, ty, tileW, tileH, 18);
      ctx.fill();
      ctx.strokeStyle = tileBorder;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(tx + 0.75, ty + 0.75, tileW - 1.5, tileH - 1.5, 18);
      ctx.stroke();

      // Value (auto-shrink)
      let valSize = 84;
      ctx.font = `800 ${valSize}px 'Courier New', Courier, monospace`;
      while (ctx.measureText(tile.value).width > tileW - 40 && valSize > 36) {
        valSize -= 4;
        ctx.font = `800 ${valSize}px 'Courier New', Courier, monospace`;
      }
      ctx.fillStyle = accentDim;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tile.value, tx + tileW / 2, ty + tileH / 2 - 10);

      // Label
      ctx.fillStyle = textSub;
      ctx.font = "600 22px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      ctx.fillText(tile.label.toUpperCase(), tx + tileW / 2, ty + tileH - 32);
    });

    // ── Footer ─────────────────────────────────────────────────
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = textSub;
    ctx.font = "500 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("timetally.ca", W / 2, H - 60);
  }

  function _shareFormatTime(seconds) {
    // Long form for the hero — e.g. "12h 34m" or "5m 20s"
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
    return `${r}s`;
  }
  function _shareFormatTimeShort(seconds) {
    // Compact for tiles — e.g. "2h 5m", "45m", "30s"
    const s = Math.max(0, Math.floor(seconds || 0));
    if (!s) return "—";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }

  async function shareCardImage() {
    const canvas = shareCanvasRef.current;
    if (!canvas) return;
    const fileName = `timetally-${(shareTarget === "overall" ? "overall" : shareTarget).replace(/[^\w-]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.png`;
    // Try Web Share API with files (mobile)
    canvas.toBlob(async (blob) => {
      if (!blob) { showIoStatus("error", "Could not create image."); return; }
      const file = new File([blob], fileName, { type: "image/png" });
      try {
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: "TimeTally stats",
            text: "My focus stats from TimeTally",
          });
          return;
        }
      } catch {
        // user cancelled or share denied; fall through to download
      }
      // Fallback: trigger download
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showIoStatus("success", "Image saved.");
    }, "image/png");
  }

  function downloadShareCard() {
    const canvas = shareCanvasRef.current;
    if (!canvas) return;
    const fileName = `timetally-${(shareTarget === "overall" ? "overall" : shareTarget).replace(/[^\w-]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.png`;
    canvas.toBlob((blob) => {
      if (!blob) { showIoStatus("error", "Could not create image."); return; }
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showIoStatus("success", "Image saved.");
    }, "image/png");
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

  // Hidden easter egg: 10 quick taps on the Sessions hero number injects a
  // plausible-looking set of fake stats across every list. No UI feedback —
  // intentional, so casual users never notice the surface. Used for screenshots
  // and the share-card preview.
  function _onSessionEasterTap() {
    const now = Date.now();
    const ref = easterTapsRef.current;
    if (now - ref.last > 4000) ref.count = 0;
    ref.last = now;
    ref.count += 1;
    if (ref.count >= 10) {
      ref.count = 0;
      _injectFakeStats();
    }
  }

  function _injectFakeStats() {
    setState((s) => {
      const next = { ...s, listStats: { ...s.listStats } };
      const todayMs = Date.now();
      const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
      for (const name of s.listOrder) {
        const sessions = rand(12, 80);
        const avgSec = rand(600, 2400);
        const timeWorked = sessions * avgSec;
        const longest = avgSec + rand(300, 3600);
        const tasks = sessions * rand(3, 9);
        const skipped = rand(0, Math.max(1, Math.floor(tasks / 12)));
        const bestStreak = rand(4, 26);
        const currentStreak = rand(0, Math.min(bestStreak, 9));
        const firstDaysAgo = rand(45, 365);
        const lastDaysAgo = rand(0, 3);
        const first = new Date(todayMs - firstDaysAgo * 86400000);
        const last = new Date(todayMs - lastDaysAgo * 86400000);
        next.listStats[name] = {
          tasksCompleted: tasks,
          timeWorked,
          sessionsCompleted: sessions,
          tasksSkipped: skipped,
          lastSession: last.toISOString(),
          firstSession: first.toISOString(),
          lastSessionDate: last.toISOString().slice(0, 10),
          longestSession: longest,
          currentStreak,
          bestStreak,
        };
      }
      return next;
    });
  }

  /* Tutorial helpers — open/dismiss/replay. Dismissal flips the persistent
     `tutorialSeen` flag so the auto-open effect won't re-fire on next load. */
  function dismissTutorial() {
    setShowTutorial(false);
    if (!stateRef.current.tutorialSeen) {
      patch((n) => { n.tutorialSeen = true; });
    }
  }
  function replayTutorial() {
    setTutorialStep(0);
    setShowTutorial(true);
  }

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
                artist: cl === "default" ? "TimeTally" : cl,
                album: "TimeTally",
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
        artist: cl === "default" ? "TimeTally" : cl,
        album: "TimeTally",
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
              <div className="stat-hero-item" onClick={_onSessionEasterTap}>
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
            <div className="stats-share-row">
              <button
                className="stats-share-btn"
                onClick={() => setShareTarget("overall")}
                title="Share overall stats as an image"
              >
                <i className="fas fa-share-nodes" /> Share overall stats
              </button>
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
                          className="stats-share-btn stats-share-btn--inline"
                          onClick={() => setShareTarget(listName)}
                          title={`Share ${listName} stats as an image`}
                        >
                          <i className="fas fa-share-nodes" /> Share
                        </button>
                        <button
                          className="stats-reset-btn"
                          onClick={() => patch((n) => { n.listStats[listName] = defaultListStats(); })}
                        >
                          Reset stats
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

    {/* Share-card modal — preview + download/share */}
    {shareTarget && (
      <div
        className={`share-modal-backdrop${state.dark ? " dark-mode" : ""}`}
        onClick={(e) => { if (e.target === e.currentTarget) setShareTarget(null); }}
      >
        <div className="share-modal">
          <div className="share-modal-header">
            <span className="share-modal-title">Share stats</span>
            <button
              className="options-close-button"
              onClick={() => setShareTarget(null)}
              aria-label="Close"
            >
              <i className="fas fa-xmark" />
            </button>
          </div>
          <div className="share-modal-body">
            <p className="share-modal-hint">
              Sized for Instagram (1080 × 1350). Tap Share to post directly or
              save the image to your device.
            </p>
            <div className="share-canvas-frame">
              <canvas ref={shareCanvasRef} className="share-canvas" />
            </div>
            <div className="share-modal-actions">
              {typeof navigator !== "undefined" && navigator.canShare && (
                <button
                  className="data-action-btn data-action-btn--primary"
                  onClick={shareCardImage}
                >
                  <i className="fas fa-share-nodes" />
                  <span>Share…</span>
                </button>
              )}
              <button
                className="data-action-btn data-action-btn--secondary"
                onClick={downloadShareCard}
              >
                <i className="fas fa-download" />
                <span>Download PNG</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {/* First-run tutorial — auto-opens on first load, replayable from Help */}
    {showTutorial && (
      <div
        className={`tutorial-overlay${state.dark ? " dark-mode" : ""}`}
        data-tut-step={TUTORIAL_STEPS[tutorialStep]?.highlight || ""}
        onClick={(e) => { if (e.target === e.currentTarget) dismissTutorial(); }}
      >
        <div className="tutorial-card" role="dialog" aria-modal="true" aria-label="Tutorial">
          <div className="tutorial-header">
            <span className="tutorial-step-counter">
              Step {tutorialStep + 1} of {TUTORIAL_STEPS.length}
            </span>
            <button className="tutorial-skip" onClick={dismissTutorial}>
              Skip
            </button>
          </div>
          <div className="tutorial-body">
            <i className={`fas ${TUTORIAL_STEPS[tutorialStep].icon} tutorial-icon`} />
            <h3 className="tutorial-title">{TUTORIAL_STEPS[tutorialStep].title}</h3>
            <p className="tutorial-text">{TUTORIAL_STEPS[tutorialStep].body}</p>
          </div>
          <div className="tutorial-progress">
            {TUTORIAL_STEPS.map((_, i) => (
              <span
                key={i}
                className={`tutorial-dot${i === tutorialStep ? " active" : ""}`}
              />
            ))}
          </div>
          <div className="tutorial-actions">
            <button
              className="tutorial-btn tutorial-btn--secondary"
              onClick={() => setTutorialStep((s) => Math.max(0, s - 1))}
              disabled={tutorialStep === 0}
            >
              <i className="fas fa-arrow-left" />
              <span>Back</span>
            </button>
            {tutorialStep < TUTORIAL_STEPS.length - 1 ? (
              <button
                className="tutorial-btn tutorial-btn--primary"
                onClick={() => setTutorialStep((s) => Math.min(TUTORIAL_STEPS.length - 1, s + 1))}
              >
                <span>Next</span>
                <i className="fas fa-arrow-right" />
              </button>
            ) : (
              <button
                className="tutorial-btn tutorial-btn--primary"
                onClick={dismissTutorial}
              >
                <i className="fas fa-check" />
                <span>Get started</span>
              </button>
            )}
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
          <button
            type="button"
            className="help-replay-tutorial"
            onClick={() => {
              patch((n) => { n.showHelp = false; });
              replayTutorial();
            }}
          >
            <i className="fas fa-rocket" />
            <span>Replay tutorial</span>
          </button>
          <div className="help-card-overlay">
            <h3><i className="fas fa-circle-play" /> Getting started</h3>
            <ul className="help-list">
              <li><b>Add a task:</b> Enter a name and duration, choose seconds / minutes / hours, then press <span className="kbd">+</span>.</li>
              <li><b>Set current task:</b> Click any task row to make it the active task.</li>
              <li><b>Enable / disable:</b> Use the toggle on each task to include or skip it during a run.</li>
              <li><b>Multiple lists:</b> Create separate lists (tabs) for different focus blocks, study sets, or circuits. Each list keeps its own settings, stats, and task order.</li>
              <li><b>Stats:</b> Open the <i className="fas fa-chart-bar" /> chart icon in the header to see per-list session count, completion rate, and time worked.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-stopwatch" /> Timer controls</h3>
            <ul className="help-list">
              <li><b>Start / Pause:</b> Start or pause the timer for the current task.</li>
              <li><b>Skip:</b> Jump to the next enabled task; remaining time on the skipped task is unchanged.</li>
              <li><b>Complete:</b> Mark the current task done immediately and advance to the next.</li>
              <li><b>Restart:</b> Reset all tasks to their original durations and return to the first task.</li>
              <li><b>Lock-screen / notification controls:</b> While a timer is running, your phone's lock screen and notification shade show play, pause, and skip buttons that drive TimeTally directly.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-sliders" /> Settings</h3>
            <ul className="help-list">
              <li><b>Display:</b> Choose what the timer bar shows (task name, time remaining, percentage, task count, ETA). Toggle compact task rows and the progress bar scope (whole list or current task).</li>
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
              <li><b>Reorder tasks:</b> Drag the grip handle (<i className="fas fa-grip-vertical" />) on the left of each row. Works with both mouse and touch.</li>
              <li><b>List tabs:</b> Open the <span className="dots">…</span> on a tab to rename or delete the list. Drag tabs to rearrange their order.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fab fa-youtube" /> YouTube support</h3>
            <ul className="help-list">
              <li><b>Add a video task:</b> Paste any YouTube URL into the task name field. Supports youtube.com, youtu.be, Shorts, and embed links.</li>
              <li><b>Auto-play:</b> The embedded player starts automatically when that task becomes active and pauses when you switch tasks.</li>
              <li><b>Import:</b> YouTube URLs in imported XML files are auto-detected and embedded.</li>
              <li><b>Listening with the screen off:</b> See the Mini player section below — opening picture-in-picture before locking the screen is the most reliable way to keep YouTube audio playing.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-up-right-and-down-left-from-center" /> Mini player (picture-in-picture)</h3>
            <ul className="help-list">
              <li><b>What it is:</b> A floating mini window that shows the current task name, countdown, and play/pause button. You can open it from the <i className="fas fa-expand-alt" /> button in the timer footer.</li>
              <li><b>Desktop (Chrome / Edge):</b> Opens a separate floating window styled to match TimeTally. You can drag, resize, and click play/pause from any other app or window.</li>
              <li><b>Mobile (Android Chrome):</b> Opens a system picture-in-picture overlay that floats above other apps. Play/pause works from inside the overlay.</li>
              <li><b>Listening with the screen locked:</b> Open the mini player <em>before</em> you lock the screen. Picture-in-picture keeps the page treated as visible, which prevents YouTube's embedded player from auto-pausing on lock. If you simply lock the screen <em>without</em> opening the mini player first, YouTube will pause itself — this is a YouTube cross-origin restriction TimeTally cannot override.</li>
              <li><b>iPhone / Safari:</b> Mini player support is limited and may be unavailable depending on iOS version.</li>
              <li><b>Mini player hidden?</b> The button only appears in browsers that support picture-in-picture (Chrome 116+ on desktop, Chrome 92+ on Android).</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-database" /> Backup &amp; Restore</h3>
            <ul className="help-list">
              <li><b>Where:</b> Tap the <i className="fas fa-database" /> icon in the header to open the Backup &amp; Restore page.</li>
              <li><b>Export:</b> Downloads every list as a single XML file you can keep as a backup or move to another browser. Includes task durations, remaining time, enabled state, and YouTube metadata.</li>
              <li><b>Import:</b> Load an XML file to add lists and tasks. Imported lists are <em>appended</em> — existing lists with the same name keep their tasks and gain the imported ones rather than being overwritten.</li>
              <li><b>Limits:</b> Maximum file size is 5 MB. Files must be valid TimeTally XML.</li>
              <li><b>Why back up?</b> All your data lives in your browser only — clearing browser data, switching devices, or trying a new browser will lose it unless you've exported a backup.</li>
            </ul>
          </div>
          <div className="help-card-overlay">
            <h3><i className="fas fa-circle-question" /> Tips</h3>
            <ul className="help-list">
              <li>Everything saves automatically in your browser — no account needed.</li>
              <li>Open TimeTally in multiple tabs; changes sync instantly between them.</li>
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

    {/* Data (Backup & Restore) full-screen overlay */}
    {showDataPage && (() => {
      // Summary stats for the export card
      const listCount = state.listOrder.length;
      let taskCount = 0;
      let totalSecondsRemaining = 0;
      let totalSecondsAll = 0;
      for (const ln of state.listOrder) {
        const ts = state.lists[ln] || [];
        taskCount += ts.length;
        for (const t of ts) {
          totalSecondsRemaining += Number(t.remaining) || 0;
          totalSecondsAll += Number(t.time) || 0;
        }
      }
      const lastIo = ioStatus;
      return (
        <div className={`options-overlay${state.dark ? " dark-mode" : ""}`}>
          <div className="options-overlay-header">
            <span className="options-overlay-title">Backup &amp; Restore</span>
            <button
              className="options-close-button"
              onClick={() => setShowDataPage(false)}
              aria-label="Close"
            >
              <i className="fas fa-xmark" />
            </button>
          </div>
          <div className="options-overlay-body data-overlay-body">

            {/* Summary card */}
            <div className="data-card">
              <h3><i className="fas fa-circle-info" /> Your data</h3>
              <div className="data-summary">
                <div className="data-summary-item">
                  <div className="data-summary-value">{listCount}</div>
                  <div className="data-summary-label">{listCount === 1 ? "list" : "lists"}</div>
                </div>
                <div className="data-summary-item">
                  <div className="data-summary-value">{taskCount}</div>
                  <div className="data-summary-label">{taskCount === 1 ? "task" : "tasks"}</div>
                </div>
                <div className="data-summary-item">
                  <div className="data-summary-value">{formatHMS(totalSecondsAll)}</div>
                  <div className="data-summary-label">total time</div>
                </div>
              </div>
              <p className="data-card-note">
                Stored locally in your browser. Nothing is uploaded to a server.
              </p>
            </div>

            {/* Export card */}
            <div className="data-card">
              <h3><i className="fas fa-cloud-arrow-down" /> Export</h3>
              <p className="data-card-text">
                Save every list to a single XML file you can keep as a backup or
                move to another browser. Includes task names, durations,
                remaining time, enabled state, and YouTube metadata.
              </p>
              <button
                className="data-action-btn data-action-btn--primary"
                onClick={() => exportTasksToXML()}
                disabled={taskCount === 0}
              >
                <i className="fas fa-cloud-arrow-down" />
                <span>Download backup</span>
              </button>
              {taskCount === 0 && (
                <p className="data-card-note data-card-note--muted">
                  Add at least one task before exporting.
                </p>
              )}
            </div>

            {/* Import card */}
            <div className="data-card">
              <h3><i className="fas fa-cloud-arrow-up" /> Import</h3>
              <p className="data-card-text">
                Load lists from an XML file you previously exported. Imported
                lists are <b>appended</b> — if a list with the same name
                already exists, the new tasks are added to the end of it
                rather than replacing what's there.
              </p>
              <button
                className="data-action-btn data-action-btn--primary"
                onClick={() => importFileRef.current?.click()}
              >
                <i className="fas fa-folder-open" />
                <span>Choose XML file…</span>
              </button>
              <ul className="data-card-bullets">
                <li>Maximum file size: 5 MB</li>
                <li>Format: TimeTally XML (<code>.xml</code>)</li>
                <li>YouTube URLs are auto-detected and re-embedded</li>
              </ul>
            </div>

            {/* Status banner — sticky inside the overlay so users see the result */}
            {lastIo && (
              <div className={`data-status data-status--${lastIo.type}${state.dark ? " dark-mode" : ""}`}>
                <i className={`fas fa-${lastIo.type === "success" ? "circle-check" : "circle-exclamation"}`} />
                <span>{lastIo.msg}</span>
              </div>
            )}

            {/* Tips card */}
            <div className="data-card">
              <h3><i className="fas fa-lightbulb" /> Tips</h3>
              <ul className="data-card-bullets">
                <li>Export before clearing browser data, switching devices, or trying a different browser.</li>
                <li>You can edit the exported XML in any text editor — the schema is straightforward.</li>
                <li>Backups don't include per-list settings or stats; those live with your browser profile.</li>
              </ul>
            </div>

          </div>
        </div>
      );
    })()}

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
        <h1>TimeTally</h1>
        <div className="header-buttons">
          <button
            className="data-button"
            title="Backup &amp; restore"
            aria-label="Open backup and restore"
            onClick={() => { setMenuOpenTask(null); setMenuOpenTab(null); setShowDataPage(true); }}
          >
            <i className="fas fa-database" />
          </button>
          {/* Hidden file input shared by the Data overlay's Import card */}
          <input
            ref={importFileRef}
            type="file"
            accept=".xml"
            onChange={onFileLoaded}
            style={{ display: "none" }}
          />
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

      {/* Always-present aria-live region so screen readers announce IO status changes */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {ioStatus?.msg ?? ""}
      </div>
    </div>

    {/* Import/Export status toast — surfaced as a floating toast when the user
        triggers IO from outside the Backup & Restore page. The Data overlay
        renders its own inline status banner, so suppress this duplicate while
        the overlay is open. */}
    {ioStatus && !showDataPage && (
      <div
        role="status"
        className={`io-toast io-toast--${ioStatus.type}${state.dark ? " dark-mode" : ""}`}
      >
        <i className={`fas fa-${ioStatus.type === "success" ? "circle-check" : "circle-exclamation"}`} />
        <span>{ioStatus.msg}</span>
      </div>
    )}

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
