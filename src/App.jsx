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

function serializeState(state) {
  return JSON.stringify({
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
  const [ioStatus, setIoStatus] = useState(null);           // { type: 'success'|'error', msg: string } | null
  const ioStatusTimerRef = useRef(null);
  const [isRunning, setIsRunning] = useState(false);
  const [editValues, setEditValues] = useState({});       // { [taskIndex]: { name, time } }
  const [renamingTab, setRenamingTab] = useState(null);   // list name being renamed
  const [renamingTabValue, setRenamingTabValue] = useState("");
  const cancelRenameRef = useRef(false);
  const saveTimerRef = useRef(null);   // debounced localStorage write handle
  const stateRef = useRef(state);      // always-current state for event handlers
  // Form input refs — avoids imperative document.getElementById reads
  const taskNameRef = useRef(null);
  const taskTimeRef = useRef(null);
  const timeUnitRef = useRef(null);
  const createListNameRef = useRef(null);
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

  /* Keep stateRef current so event handlers always see the latest state */
  useEffect(() => { stateRef.current = state; }, [state]);

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
    setIsRunning(true);

    timerRef.current = setInterval(() => {
      const now = performance.now();
      const dt = (now - (lastTick.current || now)) / 1000;
      lastTick.current = now;

      let timerEnded = false;
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
            timerEnded = true;
          } else {
            n.currentTaskIndex = nxt;
            announceStart(arr[nxt]);
            pauseAllYouTube();
            playYouTubeIfAny(nxt);      // autoplay next video's task if any
          }
        }
      });
      if (timerEnded) setIsRunning(false);
    }, 200);
  }

  function pauseTimer() {
    if (!timerRef.current) return;
    clearInterval(timerRef.current);
    timerRef.current = null;
    setIsRunning(false);
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
            <i className={`fas fa-${state.dark ? "sun" : "moon"}`} />
          </button>
        </div>
      </header>

      <div
        id="helpMenu"
        className={`help-menu${state.dark ? " dark-mode" : ""}`}
        style={{ display: state.showHelp ? "block" : "none" }}
      >
        <div className="help-grid">
          <section className="help-card">
            <h3><i className="fas fa-list-check" /> Tasks & Timing</h3>
            <ul className="help-list">
              <li><b>Add tasks:</b> Enter a task name and duration, choose units, then press <span className="kbd">+</span>.</li>
              <li><b>Select current:</b> Click any task row to set it as current. Current shows a “[Current]” tag.</li>
              <li><b>Enable/disable:</b> Use the toggle on each task to include or exclude it from the run.</li>
              <li><b>Start/Pause:</b> Use <span className="btn-chip">Start</span> and <span className="btn-chip">Pause</span>. Completion beeps if enabled.</li>
              <li><b>Skip:</b> Jumps to the next enabled task without changing the current task’s remaining time.</li>
              <li><b>Complete early:</b> Marks the current task done immediately and advances.</li>
              <li><b>Restart:</b> Resets all tasks’ remaining time to their original durations.</li>
            </ul>
          </section>

          <section className="help-card">
            <h3><i className="fab fa-youtube" /> YouTube Playlists</h3>
            <ul className="help-list">
              <li><b>Create a video task:</b> Paste a YouTube URL directly in the <em>Task Name</em> field. The app embeds the video automatically.</li>
              <li><b>Auto-play:</b> When a video task becomes current and the timer starts, playback begins automatically.</li>
              <li><b>TTS friendly:</b> Text-to-speech never reads the raw URL. It uses “YouTube video” when announcing.</li>
              <li><b>Import support:</b> Imported lists that contain YouTube URLs auto-detect and embed without manual editing.</li>
              <li><b>Playback control:</b> Non-current embeds are view-only. Select the task to interact or let the timer advance to it.</li>
            </ul>
          </section>

          <section className="help-card">
            <h3><i className="fas fa-pen-to-square" /> Editing & Menus</h3>
            <ul className="help-list">
              <li><b>Quick actions:</b> Use the <span className="dots">…</span> button on a task for Edit/Delete.</li>
              <li><b>Edit:</b> Change the task name (or YouTube URL) and total time. Remaining updates when total changes.</li>
              <li><b>List menus:</b> Use the <span className="dots">…</span> on a tab for Rename/Delete.</li>
              <li><b>Clean menus:</b> Ellipsis icons are white by default; on tasks in light mode they appear black for contrast.</li>
            </ul>
          </section>

          <section className="help-card">
            <h3><i className="fas fa-arrows-up-down-left-right" /> Reordering</h3>
            <ul className="help-list">
              <li><b>Tasks:</b> Press and drag anywhere on a task row to reorder. Interactive controls don’t initiate dragging.</li>
              <li><b>Lists:</b> Drag tabs to rearrange list order. The active list is highlighted.</li>
            </ul>
          </section>

          <section className="help-card">
            <h3><i className="fas fa-sliders" /> Options & TTS</h3>
            <ul className="help-list">
              <li><b>Per-list settings:</b> Toggle beep, enable TTS, choose a voice, and set announcement style.</li>
              <li><b>Announcements:</b> Choose to announce task name, duration, both, or a custom completion message.</li>
            </ul>
          </section>

          <section className="help-card">
            <h3><i className="fas fa-file-import" /> Import / Export</h3>
            <ul className="help-list">
              <li><b>Export:</b> Downloads an XML snapshot including YouTube metadata.</li>
              <li><b>Import:</b> XML files automatically detect YouTube URLs and embed videos on load.</li>
            </ul>
          </section>

          <section className="help-card">
            <h3><i className="fas fa-cloud" /> Persistence & Sync</h3>
            <ul className="help-list">
              <li><b>Auto-save:</b> All lists, progress, and settings persist to the browser.</li>
              <li><b>Cross-tab sync:</b> Changes propagate immediately across open tabs/windows of the same browser profile.</li>
              <li><b>Dark mode:</b> Toggle from the header. Theme preference persists.</li>
            </ul>
          </section>

          <section className="help-card">
            <h3><i className="fas fa-circle-question" /> Tips</h3>
            <ul className="help-list">
              <li>Use multiple lists to separate focus blocks, study sets, or workout circuits.</li>
              <li>Disable tasks you want to skip without losing their setup.</li>
              <li>Keep YouTube tasks near relevant steps; auto-play aligns video and timing.</li>
            </ul>
          </section>
        </div>
      </div>

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
          <input
            type="text"
            id="taskName"
            ref={taskNameRef}
            placeholder="Task Name or YouTube URL"
            onKeyDown={(e) => { if (e.key === "Enter") taskTimeRef.current?.focus(); }}
          />
          <input
            type="number"
            id="taskTime"
            ref={taskTimeRef}
            placeholder="Time"
            onKeyDown={(e) => { if (e.key === "Enter") addTaskUI(); }}
          />
          <select id="timeUnit" ref={timeUnitRef} aria-label="Time Unit" defaultValue="minutes">
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
          const itemCls = `task-item${isCurrent ? " current" : ""}${state.dark ? " dark-mode" : ""}`;
          // Robust: compute ytId from meta first, otherwise from the name if it is a URL
          const ytId = t?.meta?.ytId || (isYouTubeUrl(t.name) ? parseYouTubeId(t.name) : null);
          const key = `${state.currentList}__${i}`;
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
                      autoFocus
                    />
                    <div className="task-edit-time-row">
                      <input
                        type="number"
                        value={editValues[i]?.time ?? t.time}
                        onChange={(e) => setEditValues((prev) => ({ ...prev, [i]: { ...(prev[i] || {}), time: e.target.value } }))}
                        min="1"
                      />
                      <span className="task-edit-unit">seconds total</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="task-name">
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
                        setEditValues((prev) => ({ ...prev, [i]: { name: t.name, time: t.time } }));
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

                {t.editing && (
                  <>
                    <button
                      title="Save"
                      onClick={(e) => {
                        e.stopPropagation();
                        const ev = editValues[i] || {};
                        const newName = String(ev.name ?? t.name).trim();
                        const newTime = Number(ev.time ?? t.time);
                        if (newName && newTime > 0) editTask(i, { name: newName, time: newTime });
                        editTask(i, { editing: false });
                        setEditValues((prev) => { const next = { ...prev }; delete next[i]; return next; });
                        setMenuOpenTask(null);
                      }}
                    >
                      <i className="fas fa-save" />
                    </button>
                    <button
                      className="btn-cancel"
                      title="Cancel"
                      onClick={(e) => {
                        e.stopPropagation();
                        editTask(i, { editing: false });
                        setEditValues((prev) => { const next = { ...prev }; delete next[i]; return next; });
                        setMenuOpenTask(null);
                      }}
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

      {/* Sticky controls footer */}
      <div className={`controls-footer${state.dark ? " dark-mode" : ""}`}>

        {/* Timer */}
        <div className={`timer-section${state.dark ? " dark-mode" : ""}`}>
          <div className={`progress-container${state.dark ? " dark-mode" : ""}`}>
            <div className={`progress-bar${state.dark ? " dark-mode" : ""}`} style={{ width: `${progress}%` }} />
          </div>
          <div className={`timer-info${state.dark ? " dark-mode" : ""}`}>
            <div id="timerText" className="timer-task-name">
              {tasks[state.currentTaskIndex]
                ? (isYouTubeUrl(tasks[state.currentTaskIndex].name) ? "YouTube video" : tasks[state.currentTaskIndex].name)
                : "Ready"}
            </div>
            <div id="timerPercent" className="timer-percent">{progress}%</div>
          </div>
        </div>

        {/* Controls */}
        <div className="controls">
          <button
            className={isRunning ? "btn-pause" : "btn-start"}
            onClick={isRunning ? pauseTimer : startTimer}
            title={isRunning ? "Pause Timer" : "Start Timer"}
          >
            <i className={`fas fa-${isRunning ? "pause" : "play"}`} />
            {isRunning ? " Pause" : " Start"}
          </button>
          <button className="btn-skip" onClick={skipTask} title="Skip Current Task"><i className="fas fa-forward" /> Skip</button>
          <button className="btn-complete" onClick={completeEarly} title="Complete Early"><i className="fas fa-check" /> Complete</button>
          <button className="btn-red" onClick={restartTimer} title="Restart All Tasks"><i className="fas fa-undo-alt" /> Restart</button>
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
  );
}
