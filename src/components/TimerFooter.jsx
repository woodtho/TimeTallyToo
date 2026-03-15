import React from "react";

/* Fix #9: Extracted from App.jsx to isolate the footer/timer display from the
   200ms setState tick. React.memo prevents re-renders when timer props are
   unchanged (e.g. when only unrelated state like menuOpenTask changes). */

/* ---------- helpers needed locally ---------- */
// Re-declare here so this component has no dependency on App internals.
// formatHMS and isYouTubeUrl are pure functions duplicated from App.jsx.
// NOTE: If the project ever grows a shared utils module, import from there instead.
function _formatHMS(total) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function _isYouTubeUrl(value = "") {
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

const TimerFooter = React.memo(function TimerFooter({
  config,
  dark,
  isRunning,
  isWarning,
  currentTask,
  progress,
  timerDisplayTime,
  enabledTaskCount,
  currentEnabledPos,
  startTimer,
  pauseTimer,
  skipTask,
  completeEarly,
  restartList,
}) {
  return (
    <div
      className={`controls-footer${dark ? " dark-mode" : ""}${isRunning ? " running" : ""}${isWarning ? " warning" : ""}`}
    >
      {/* Timer */}
      <div className={`timer-section${dark ? " dark-mode" : ""}`}>
        <div className={`progress-container${dark ? " dark-mode" : ""}`}>
          <div className={`progress-bar${dark ? " dark-mode" : ""}`} style={{ width: `${progress}%` }} />
        </div>
        <div className={`timer-info${dark ? " dark-mode" : ""}`}>
          {config.timerShowTaskName && (
            <div id="timerText" className="timer-task-name">
              {currentTask ? (_isYouTubeUrl(currentTask.name) ? "YouTube video" : currentTask.name) : "Ready"}
            </div>
          )}
          {config.timerShowCount && enabledTaskCount > 0 && (
            <div className="timer-count">{currentEnabledPos} / {enabledTaskCount}</div>
          )}
          {config.timerShowRemaining && (
            <div className="timer-remaining">{_formatHMS(timerDisplayTime)}</div>
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
          title={isRunning ? "Pause timer" : "Start timer"}
          aria-label={isRunning ? "Pause timer" : "Start timer"}
        >
          <i className={`fas fa-${isRunning ? "pause" : "play"}`} />
          {isRunning ? " Pause" : " Start"}
        </button>
        <button className="btn-skip" onClick={skipTask} title="Skip current task" aria-label="Skip current task">
          <i className="fas fa-forward" /> Skip
        </button>
        <button className="btn-complete" onClick={completeEarly} title="Complete current task early" aria-label="Complete current task early">
          <i className="fas fa-check" /> Complete
        </button>
        <button className="btn-red" onClick={restartList} title="Restart all tasks" aria-label="Restart all tasks">
          <i className="fas fa-undo-alt" /> Restart
        </button>
      </div>
    </div>
  );
});

export default TimerFooter;
