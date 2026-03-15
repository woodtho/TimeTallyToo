import React from "react";

/* Fix #9: Extracted from App.jsx to isolate the task list rendering from the
   200ms setState tick. React.memo prevents re-renders when unrelated App state
   changes (e.g. menuOpenTab, showOptions). The list only re-renders when its
   own props change. */

/* ---------- pure helpers (duplicated from App.jsx module scope) ---------- */
// These are stable pure functions. If a shared utils module is introduced,
// import from there and remove these copies.

const YT_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function safeYtId(id) {
  return id && YT_ID_RE.test(id) ? id : null;
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
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1) || null;
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "shorts" && parts[1]) return parts[1];
    if (parts[0] === "embed" && parts[1]) return parts[1];
    return null;
  } catch {
    return null;
  }
}

function ytIframeSrc(id) {
  return `https://www.youtube.com/embed/${id}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1`;
}

function formatHMS(total) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

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

/* ---------- component ---------- */

const TaskList = React.memo(function TaskList({
  tasks,
  config,
  dark,
  currentTaskIndex,
  currentList,
  editValues,
  menuOpenTask,
  listRef,
  // callbacks
  editTask,
  removeTask,
  patch,
  setEditValues,
  setMenuOpenTask,
  onTaskPointerDown,
  onTaskPointerMove,
  onTaskPointerUp,
}) {
  return (
    <ul id="taskList" ref={listRef} className={config.compactTasks ? "compact" : ""}>
      {tasks.map((t, i) => {
        const isCurrent = i === currentTaskIndex;
        const itemCls = `task-item${isCurrent ? " current" : ""}${!t.enabled ? " disabled" : ""}${t.editing ? " editing" : ""}${dark ? " dark-mode" : ""}`;
        // Validate ytId against the strict 11-char regex before embedding
        const ytId = safeYtId(t?.meta?.ytId || (isYouTubeUrl(t.name) ? parseYouTubeId(t.name) : null));

        const saveEdit = (e) => {
          e?.stopPropagation();
          const ev = editValues[t.id] || {};
          const newName = String(ev.name ?? t.name).trim();
          const newTime = fromDisplayTime(ev.time ?? t.time, ev.unit || "seconds");
          if (newName && newTime > 0) editTask(i, { name: newName, time: newTime });
          editTask(i, { editing: false });
          setEditValues((prev) => { const next = { ...prev }; delete next[t.id]; return next; });
          setMenuOpenTask(null);
        };
        const cancelEdit = (e) => {
          e?.stopPropagation();
          editTask(i, { editing: false });
          setEditValues((prev) => { const next = { ...prev }; delete next[t.id]; return next; });
          setMenuOpenTask(null);
        };

        return (
          <li
            key={t.id}
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
                    value={editValues[t.id]?.name ?? t.name}
                    onChange={(e) => setEditValues((prev) => ({ ...prev, [t.id]: { ...(prev[t.id] || {}), name: e.target.value } }))}
                    placeholder="Task name or YouTube URL"
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEdit(e); } else if (e.key === "Escape") cancelEdit(e); }}
                    autoFocus
                  />
                  <div className="task-edit-time-row">
                    <input
                      type="number"
                      value={editValues[t.id]?.time ?? t.time}
                      onChange={(e) => setEditValues((prev) => ({ ...prev, [t.id]: { ...(prev[t.id] || {}), time: e.target.value } }))}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEdit(e); } else if (e.key === "Escape") cancelEdit(e); }}
                      min="1"
                    />
                    <select
                      className="task-edit-unit-select"
                      value={editValues[t.id]?.unit ?? "seconds"}
                      onChange={(e) => setEditValues((prev) => ({ ...prev, [t.id]: { ...(prev[t.id] || {}), unit: e.target.value } }))}
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
                  className={`menu-popover${dark ? " dark-mode" : ""}`}
                  style={{ right: 0, top: "calc(100% + 6px)" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="menu-item"
                    onClick={() => {
                      const unit = bestUnit(t.time);
                      setEditValues((prev) => ({ ...prev, [t.id]: { name: t.name, time: toDisplayTime(t.time, unit), unit } }));
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
  );
});

export default TaskList;
