import React from "react";

/* ---------- helpers ---------- */
function formatHMS(total) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
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

/* ---------- PipOverlay ----------
   Design tokens mirror public/styles.css (same file cannot be loaded in the
   Document PiP document because styles.css is scoped to the main document).
   Tokens:
     .timer-section        bg: #fafafa / #2a2a2a, border: 1px #ccc / #444
     .progress-container   bg: #ddd    / #333
     .progress-bar         bg: #4caf50 / #76c7c0   (the teal/mint in dark mode)
     .timer-remaining      color: #2196f3 / #90caf9, font: 'Courier New'
     .timer-task-name      color: #333 / #eee, bold 13px
     .btn-start            bg: #4caf50 (hover #43a047)
     .btn-pause            bg: #757575 (hover #616161)
     .controls-footer      bg: #fff / #1e1e1e, border-top 1px #e0e0e0 / #333
*/
export default function PipOverlay({
  isRunning,
  currentTask,
  timerDisplayTime,
  progress,
  dark,
  startTimer,
  pauseTimer,
}) {
  const rawName = currentTask?.name ?? "";
  const isYT = isYouTubeUrl(rawName);
  const taskLabel = currentTask ? (isYT ? "YouTube video" : rawName) : "Ready";

  // Palette
  const pageBg     = dark ? "#1e1e1e" : "#f5f5f5";
  const cardBg     = dark ? "#2a2a2a" : "#fafafa";
  const borderCol  = dark ? "#444"    : "#ccc";
  const trackBg    = dark ? "#333"    : "#ddd";
  const barColor   = dark ? "#76c7c0" : "#4caf50";
  const barPaused  = dark ? "#555"    : "#bbb";
  const labelCol   = dark ? "#eee"    : "#333";
  const subtleCol  = dark ? "#aaa"    : "#777";
  const timerCol   = dark ? "#90caf9" : "#2196f3";
  const btnStart   = "#4caf50";
  const btnPause   = "#757575";
  const ytBadge    = dark ? "#ff5252" : "#c62828";
  const shadowCol  = dark ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.18)";

  const fontStack  = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const clampedPct = Math.min(100, Math.max(0, progress));

  return (
    <div
      style={{
        fontFamily: fontStack,
        background: pageBg,
        color: labelCol,
        padding: 10,
        height: "100%",
        boxSizing: "border-box",
        display: "flex",
      }}
    >
      {/* Card — mirrors .timer-section inside .controls-footer */}
      <div
        style={{
          flex: 1,
          background: cardBg,
          border: `1px solid ${borderCol}`,
          borderRadius: 10,
          padding: "12px 14px 10px",
          boxShadow: `0 4px 14px ${shadowCol}`,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          boxSizing: "border-box",
          minHeight: 0,
        }}
      >
        {/* Progress bar — 6px like the main app .progress-container */}
        <div
          aria-hidden="true"
          style={{
            height: 6,
            background: trackBg,
            borderRadius: 3,
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${clampedPct}%`,
              background: isRunning ? barColor : barPaused,
              transition: "width 0.3s ease",
              borderRadius: 3,
            }}
          />
        </div>

        {/* Task name row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 18, flexShrink: 0 }}>
          {isYT ? (
            <span
              style={{
                background: ytBadge,
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                padding: "3px 8px",
                borderRadius: 10,
                letterSpacing: 0.2,
                whiteSpace: "nowrap",
              }}
            >
              ▶ YouTube
            </span>
          ) : (
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: labelCol,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                minWidth: 0,
              }}
            >
              {taskLabel}
            </div>
          )}
          <div
            style={{
              marginLeft: "auto",
              fontSize: 11,
              fontWeight: 600,
              color: subtleCol,
              fontVariantNumeric: "tabular-nums",
              flexShrink: 0,
            }}
          >
            {Math.round(clampedPct)}%
          </div>
        </div>

        {/* Time remaining — 'Courier New', blue/light-blue, matches .timer-remaining */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            fontFamily: "'Courier New', Courier, monospace",
            fontSize: 40,
            fontWeight: 700,
            color: isRunning ? timerCol : subtleCol,
            letterSpacing: "0.04em",
            lineHeight: 1,
            minHeight: 0,
            textShadow: dark ? "0 1px 0 rgba(0,0,0,0.4)" : "none",
          }}
        >
          {formatHMS(timerDisplayTime)}
        </div>

        {/* Play / Pause — mirrors .btn-start / .btn-pause */}
        <button
          type="button"
          onClick={isRunning ? pauseTimer : startTimer}
          style={{
            background: isRunning ? btnPause : btnStart,
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "10px 0",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
            width: "100%",
            letterSpacing: "0.3px",
            flexShrink: 0,
            boxShadow: `0 2px 6px ${shadowCol}`,
            transition: "background 0.15s ease, transform 0.1s ease",
            fontFamily: fontStack,
          }}
          onMouseDown={(e) => { e.currentTarget.style.transform = "scale(0.98)"; }}
          onMouseUp={(e)   => { e.currentTarget.style.transform = "scale(1)"; }}
          onMouseLeave={(e)=> { e.currentTarget.style.transform = "scale(1)"; }}
        >
          {isRunning ? "⏸  Pause" : "▶  Play"}
        </button>
      </div>
    </div>
  );
}
