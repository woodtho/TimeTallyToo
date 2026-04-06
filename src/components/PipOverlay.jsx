import React from "react";

function formatHMS(total) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function PipOverlay({ isRunning, currentTask, timerDisplayTime, progress, dark, startTimer, pauseTimer }) {
  const taskName = currentTask
    ? (currentTask.name.match(/^https?:\/\//) ? "▶ Video task" : currentTask.name)
    : "Ready";

  const bg = dark ? "#1e1e1e" : "#f5f5f5";
  const fg = dark ? "#e0e0e0" : "#212121";
  const subtle = dark ? "#333" : "#ddd";

  return (
    <div style={{
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      background: bg,
      color: fg,
      padding: "14px 14px 12px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 8,
      boxSizing: "border-box",
    }}>
      {/* Progress bar */}
      <div style={{ height: 4, background: subtle, borderRadius: 2, flexShrink: 0 }}>
        <div style={{
          height: "100%",
          width: `${progress}%`,
          background: "#4caf50",
          borderRadius: 2,
          transition: "width 0.2s",
        }} />
      </div>

      {/* Task name */}
      <div style={{
        fontSize: 12,
        fontWeight: 600,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        opacity: 0.75,
        flexShrink: 0,
      }}>
        {taskName}
      </div>

      {/* Time remaining */}
      <div style={{
        fontSize: 34,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "-0.5px",
        lineHeight: 1,
        flex: 1,
        display: "flex",
        alignItems: "center",
      }}>
        {formatHMS(timerDisplayTime)}
      </div>

      {/* Play / Pause button */}
      <button
        onClick={isRunning ? pauseTimer : startTimer}
        style={{
          background: isRunning ? "#757575" : "#4caf50",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "11px 0",
          fontSize: 15,
          fontWeight: 700,
          cursor: "pointer",
          width: "100%",
          flexShrink: 0,
          letterSpacing: "0.3px",
        }}
      >
        {isRunning ? "⏸  Pause" : "▶  Play"}
      </button>
    </div>
  );
}
