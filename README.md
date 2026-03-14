# TimeTally

TimeTally is a React + Vite timer app for running structured task lists. You can organize tasks into multiple lists, assign durations, start a guided run, and let the app advance through each enabled task while tracking remaining time and estimated finish.

The app is built for workflows like study blocks, workout circuits, routines, and step-by-step sessions that benefit from timing, quick reordering, and lightweight persistence.

## Highlights

- Multiple task lists with draggable tabs
- Per-task timers with start, pause, skip, complete, and restart controls
- Optional per-list beep and text-to-speech announcements
- YouTube URL support with automatic embedded playback for the active task
- XML import/export for saving or sharing task sets
- Local persistence with cross-tab sync in the same browser profile
- Dark mode and mobile-friendly layout

## How It Works

Each list contains timed tasks. When you start a run, TimeTally begins at the current enabled task and moves forward automatically as tasks complete.

- Disabled tasks are skipped without being deleted
- `Skip` moves to the next enabled task without changing the current task's remaining time
- `Complete` finishes the current task immediately and advances
- `Restart` resets the active list back to its original task durations
- The ETA panel shows both the expected finish time and total remaining time

If a task name is a YouTube URL, the app treats it as a video task. The video is embedded automatically, and the active task can autoplay when the timer begins.

## Features

### Task and list management

- Add tasks in seconds, minutes, or hours
- Click any task to make it current
- Edit or delete tasks from the task menu
- Reorder tasks with drag and drop
- Create, rename, delete, and reorder lists

### Audio and announcements

- Enable or disable a completion beep per list
- Enable browser text-to-speech per list
- Pick a speech voice from the available browser voices
- Choose announcement behavior:
  - start with task name and duration
  - start with task name only
  - start with duration only
  - custom completion message
  - random affirmation on completion

### Import, export, and persistence

- Export all lists to `timetally_tasks.xml`
- Import saved XML back into the app
- YouTube task metadata is preserved in exports
- State is saved to browser storage automatically
- Open tabs stay in sync through `localStorage` and `BroadcastChannel`

## Tech Stack

- React 19
- Vite 7
- Plain CSS
- GitHub Pages for deployment

## Local Development

### Prerequisites

- Node.js 18+ recommended
- npm

### Install

```bash
npm install
```

### Run the dev server

```bash
npm run dev
```

### Build for production

```bash
npm run build
```

### Preview the production build

```bash
npm run preview
```

## Deployment

This project is configured for GitHub Pages with the base path:

```txt
/TimeTallyToo/
```

Deployment uses the existing npm scripts:

```bash
npm run deploy
```

That runs the production build and publishes `dist/` through `gh-pages`.

## Project Structure

```txt
.
|-- public/
|-- src/
|   |-- App.jsx
|   |-- App.css
|   |-- index.css
|   `-- main.jsx
|-- package.json
`-- vite.config.js
```

## Notes

- TimeTally is browser-first and stores state locally in the browser
- Speech synthesis depends on browser support and installed voices
- YouTube playback behavior can vary depending on browser autoplay rules

## Live Site

<https://woodtho.github.io/TimeTallyToo/>
