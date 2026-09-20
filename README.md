# StudyTracker

Local-first desktop app for tracking study workload across subjects. Structure each
subject as a tree of tasks with estimated effort, run countdown sessions against those
tasks, type percent complete per leaf, and read effort-weighted progress and time
statistics. Everything lives in one SQLite file plus CSV mirrors you can open in Excel
or Python while the app is running. No accounts, no network.

## Stack

| Layer | Choice |
| --- | --- |
| UI | React 19, TypeScript, Tailwind v4, Radix primitives, Recharts, lucide icons |
| Shell | Tauri 2 (macOS `.app`, Windows `.exe`/NSIS cross-built from macOS; Linux untested) |
| Storage | SQLite via `tauri-plugin-sql`; sql.js + IndexedDB when run in a plain browser |
| Export | SheetJS (`xlsx`) for the workbook, Tauri fs plugin for CSV mirrors |

## Run

```bash
npm install
npm run tauri dev        # native window (needs Rust: https://rustup.rs)
npm run dev              # browser-only mode at http://localhost:1420 (IndexedDB storage)
npm test                 # acceptance tests (vitest, in-memory sql.js)
npm run tauri build      # produces src-tauri/target/release/bundle/macos/StudyTracker.app
npm run install:mac      # build the .app and copy it into /Applications
npm run release:mac      # universal (Intel + Apple silicon) app zipped into release/
npm run release:web      # browser build zipped into release/
npm run release:win-web  # browser build + double-click launcher for Windows, zipped into release/
npm run release:win      # Windows .exe + installer cross-compiled with cargo-xwin (see below)
```

## Sharing the app with other people

* **macOS, no install**: `npm run release:mac` builds a universal (Intel + Apple silicon)
  app and zips it to `release/StudyTracker-mac.zip`. Send that zip plus `INSTALL.txt`.
  The recipient unzips and double-clicks; because the build is only ad-hoc signed they
  approve it once under System Settings → Privacy & Security → "Open Anyway". Removing
  that prompt needs an Apple Developer ID certificate and notarization
  (`bundle.macOS.signingIdentity` in `tauri.conf.json`, then `xcrun notarytool`).
* **Web, any OS**: `npm run release:web` builds the browser version into
  `release/StudyTracker-web.zip`. Host the contents on any static host (GitHub Pages,
  Netlify, Vercel, Cloudflare Pages) or serve locally with `npx serve dist`. Pushing to
  GitHub also publishes it automatically via `.github/workflows/pages.yml` once GitHub
  Pages is enabled with "GitHub Actions" as the source. Browser mode keeps data in
  IndexedDB and has no CSV mirror or folder picker; exports download.
* **Windows, no install (browser edition)**: `npm run release:win-web` builds
  `release/StudyTracker-windows-web.zip`. The recipient unzips it and double-clicks
  `StudyTracker.cmd`: a bundled PowerShell script serves the `app/` folder on
  `http://localhost:4173` and opens it in an app-style Edge/Chrome window with its own
  profile. Nothing to install, no admin rights; data lives in that browser profile under
  `%LOCALAPPDATA%\StudyTracker`. Sources are in `windows-launcher/`.
* **Windows desktop app, built on this Mac**: `npm run release:win` cross-compiles with
  `cargo-xwin` and produces `release/StudyTracker-windows-portable.zip` (just
  `StudyTracker.exe`, unzip and double-click). It then tries to make the NSIS installer
  (`release/StudyTracker_<version>_x64-setup.exe`, per-user, no admin); Homebrew's `makensis`
  currently crashes with `std::bad_alloc` on macOS, in which case the script just warns and the
  installer comes from the GitHub workflow instead. One-time setup: `brew install nsis llvm lld`,
  `rustup target add x86_64-pc-windows-msvc`, `cargo install --locked cargo-xwin`
  (the first build also downloads the Windows SDK, ~1 GB, into `~/Library/Caches/cargo-xwin`).
  Windows 10/11 ship the WebView2 runtime the exe needs; the installer fetches it if missing.
  Recipients click "More info → Run anyway" on SmartScreen once; a code-signing certificate
  removes that. The same artefacts are built by `.github/workflows/release.yml` when a
  `v*` tag is pushed.
* Desktop builds keep data in `~/StudyTracker` (`%USERPROFILE%\StudyTracker` on Windows).

## Where data lives

On first launch the app asks for a folder (default `~/StudyTracker`). It contains:

```
studytracker.db        SQLite database (WAL mode)
nodes.csv              regenerated on every write when the CSV mirror is on
sessions.csv
pct_history.csv
checklist.csv
weekly_summary.csv
backups/               daily copy of the .db, last seven kept
```

The chosen path is remembered in the webview's localStorage; change it under Settings.

## Backup and restore

**Settings → Backup & restore → Download backup** writes one `.json` file holding everything:
projects and tasks, logged sessions, percent and status history, checklists and settings.
Keep it wherever you keep your own files — it is the copy that survives a lost laptop, a
cleared browser or a move between the desktop app and the browser edition.

**Restore from backup…** takes that file back in. It also accepts:

* `studytracker.db` — the database file itself (the desktop app's, or **Download .db** in
  the browser edition), and
* the exported CSVs — pick `nodes.csv` together with `sessions.csv`, `pct_history.csv`,
  `status_history.csv` and `checklist.csv` in one go and everything comes back with them.
  Files are recognised by their header, so `nodes (1).csv` works too. CSVs carry no
  settings, so targets, presets and the backdrop are left as they are.

A restore replaces everything currently in the app, so it shows what the file holds against
what is there now and offers to save a copy of the current data first. Either the whole
restore lands or none of it does — a failure part way leaves the database untouched.

The desktop app also keeps seven daily copies of the database in `backups/`; the browser
edition has no such folder, so the downloaded backup is the only copy there.

## Data model

`nodes` — id, parent_id (null for subjects), name, depth, sort_order, est_effort,
pct_complete (leaves only), deadline, created_at, updated_at, weight (share among
siblings, default 1), rollup_mode (`equal`|`weight`|`effort`|null = inherit), and
subject-only fields unit, hours_per_unit, weekly_target_hours, color.

`pct_history` — one row per leaf percent change (id, node_id, pct, changed_at).

`checklist_items` — tick boxes under a leaf task (id, node_id, label, done, sort_order,
created_at). While a task has items, its percent is derived: done ÷ total, each item
counting equally, written through the normal percent path so it appears in `pct_history`.
The slider and percent field are locked until the last item is removed.

`sessions` — id, node_id (nullable), cycle_id (nullable), mode (`single`|`cycle`),
planned_seconds, actual_seconds, started_at, ended_at, ended_reason
(`completed`|`aborted_credited`|`aborted_discarded`), note. Discarded sessions are stored
with `actual_seconds = 0` so no time is counted, but they still appear in completion rate.

`settings` — key/value JSON. Schema is versioned with `PRAGMA user_version`; migrations
live in `src/db/migrations.ts`.

### Roll-up rules

Every parent combines its **direct children** with one of three rules. The default rule
lives in Settings → Roll-up (`rollup_mode` setting, default `equal`); any subject or
group can override it from its detail panel (`nodes.rollup_mode`), and the override is
inherited by everything beneath it.

| Rule | Parent percent |
| --- | --- |
| `equal` | mean of child percents — a group counts once, however many tasks it holds |
| `weight` | Σ(child `weight` × child pct) ÷ Σ child `weight`; weights default to 1, 0 excludes a child |
| `effort` | Σ(leaf `est_effort` × leaf pct) ÷ Σ leaf `est_effort` over all descendant leaves; leaves without an estimate carry no weight, and if none has one the mean of leaf percents is used |

* `estTotal` is always the plain sum of descendant leaf estimates so hour statistics are
  comparable across rules; `doneTotal = estTotal × pct / 100` follows the displayed percent.
* Status is derived: 0 → Not started, 100 → Done, otherwise In progress.
* Root shows overall percent and total hours logged. Estimated and remaining hours appear
  only when every subject can be converted to hours (`hours_per_unit` set, or unit is
  `hours`).

## Screens

* **Tree** — collapsible tree, inline rename/effort/percent (slider or typed), per-task
  checklist in the detail panel (e.g. Theory / Exercise / Review) that drives the task's
  percent and shows as a 2/3 chip on the row, drag rows
  to reorder (drop on upper/lower quarter) or re-nest (drop on the middle), right-click
  for add child / start timer / rename / duplicate / delete. A **Due** column shows each
  row's deadline relative to today (today / in 3d / 2d overdue; finished work is struck
  through); a parent without its own date shows, in italics, the earliest deadline among
  its open tasks. The header's sort control orders every sibling group by priority
  (remaining effort per day until due), due date, progress, remaining effort or name;
  manual order is the stored drag-and-drop order and the only mode where dragging is
  enabled. The numeric columns (%, Est. effort, Weight, Due) and the details pane are
  resizable by dragging their dividers (double-click to reset) and remembered per device;
  Name and Progress keep their own flexible widths. Right panel shows detail, sessions, weekly hours,
  percent sparkline. Header shows root totals and a subject filter.
* **Timer** — Single (dial or typed duration, editable presets) or Cycle (work, break,
  rounds, long break every N). Each work block writes its own session row sharing a
  `cycle_id`; breaks are never logged. Pause/resume, +5/+10, abort with credit or discard.
  Settings › Focus screen adds an optional backdrop image (shrunk to 1920px, stored in the
  database) with a dark or light translucent overlay of adjustable strength, and a custom
  bell sound (MP3/WAV/OGG/M4A up to 3 MB) in place of the built-in chime.
  Untagged sessions trigger one skippable tag prompt per run.
* **Inbox** — sessions with no task; assign one at a time or many at once. Badge appears
  when untagged time exceeds the threshold setting.
* **Dashboard** — today gauge, this week per subject with a "behind two full weeks" flag,
  stacked time by subject (day/week/month, always with an Unassigned bucket), planned vs
  actual with an overrun flag (hours > estimate while < 80 %), pace against the deadline,
  session stats and hour-of-day heatmap.
* **Settings** — storage folder, daily target, presets, cycle defaults, badge threshold,
  default roll-up rule, skin, theme, sound, CSV mirror, xlsx export, CSV merge with preview,
  and **Backup & restore**.

### Pace & finish

Each project shows the pace it is actually moving at, the pace it *needs* from today to
finish by its deadline, and where today's pace lands it on the day — under 100 % means
it misses. The deadline is the project's own, or the nearest one among its unfinished
tasks, so dating the chapter rather than the subject works. Pace is points gained divided
by the days it took, counted from the day the project started, so a project started this
morning reads as a day's work rather than an hour's; the dot beside it says how much
history it rests on.

## Skins

Three skins restyle the whole app without touching layout or data: **Clean** (the original,
light/dark), **Terminal** (monospace, square, phosphor green; light/dark) and **Soft**
(rounded pastel cards; light/dark).

A skin is pure CSS: `src/index.css` defines the design tokens (colours, fonts, radii,
border widths, shadows, paper texture) on `:root`, a set of semantic component classes
(`.btn`, `.input`, `.card`, `.seg`, `.nav-item`, `.menu`, `.dialog`, `.toast`, `.pill`,
`.tile`, `.choice`, `.progress`, `.round-btn`, …) that read only those tokens, and then
one `html[data-skin="…"]` block per skin that overrides the tokens plus a few class-level
tweaks. Components never branch on the skin. The registry of skins is
`src/lib/skins.ts`; `applyTheme()` in `src/store/app.ts` sets `data-skin` and the
`.dark` class on `<html>`.

## Keyboard

`space` start/pause timer · `N` new task under the selected node (or a new subject) ·
`E` edit percent of the selected row · `⌘Z` undo (delete, percent edits, session delete) ·
`Alt+↑` / `Alt+↓` move the selected row among its siblings (manual order only).

## Assumptions carried from the spec

* Tree depth is unlimited; the UI is tuned for three levels.
* Deadlines drive the Due column and the sort orders; there is no burn-down chart.
* Break blocks are never study time.
* Weeks start on Monday.
* Subject colours propagate to every chart.
* A subject with `unit = hours` and no `hours_per_unit` converts 1:1.
* A new child task starts with `est_effort = 1` and `weight = 1`; under the `effort` rule
  clear the estimate to exclude it, under the `weight` rule set the weight to 0.

## Implementation notes

* Multi-statement writes go through the Rust `sql_batch` command, which runs them in one
  transaction on a single SQLite connection. The SQL plugin's `execute` is pooled, so a
  front-end `BEGIN`/`COMMIT` pair can land on different connections and hold a write lock.
* Only the name cell of a tree row is draggable, so sliders and inputs keep their own
  pointer gestures. The dragged id is tracked in module state because WebKit does not
  expose custom `dataTransfer` types during `dragover`.
