# StudyTracker — Project Map

Handoff note for a fresh session. Describes what lives where and how the pieces
connect. Folder on disk is `~/Downloads/Pomofocus`; the app itself is named
**StudyTracker** (`package.json` name `studytracker`). **Not a git repo** (no `.git`),
though `.github/workflows` exist for when it is pushed.

## What it is

Local-first study/workload tracker. Subjects are trees of tasks with estimated effort;
countdown (Pomodoro-style) sessions log time against tasks; percent complete rolls up
the tree; a dashboard reads time and progress statistics. One SQLite file + CSV mirrors.
No accounts, no network.

Two runtimes from one React codebase:
- **Desktop (Tauri 2)** — SQLite via `tauri-plugin-sql`, real folder on disk, CSV mirror,
  native notifications, daily DB backups.
- **Browser (vite dev / static host)** — sql.js + IndexedDB, exports become downloads,
  no folder picker and no CSV mirror.

## Top level

```
.claude/launch.json        preview server configs: "studytracker-web" (npm run dev, :1420),
                           "studytracker-dist" (python http.server on dist, :4173)
.github/workflows/
  pages.yml                pushes browser build to GitHub Pages on push to main
  release.yml              on tag v* builds macOS universal .app + Windows NSIS -> draft release
index.html                 vite entry, mounts #root
vite.config.ts             react + tailwind v4 plugins; base "./"; dev port 1420 (strictPort);
                           vitest config lives here (environment node, src/**/*.test.ts)
tsconfig.json              strict, ES2022, jsx react-jsx, path alias @/* -> src/*
package.json               scripts: dev, build, test, tauri, install:mac, release:mac, release:web,
                           release:win-web (browser build + Windows launcher), release:win (cargo-xwin cross-build)
scripts/release-win.sh     Windows cross-build: needs brew nsis/llvm/lld + cargo-xwin + msvc target
windows-launcher/          StudyTracker.cmd + serve.ps1 (PowerShell HttpListener static server on :4173,
                           opens Edge/Chrome --app window with its own profile) + README-Windows.txt
README.md                  full spec: data model, roll-up rules, screens, skins, keyboard, assumptions
INSTALL.txt                note shipped next to release/StudyTracker-mac.zip (Gatekeeper steps)
dist/                      build output (gitignored; `npm run build` recreates it)
release/                   packaged zips: StudyTracker-mac.zip, StudyTracker-web.zip,
                           StudyTracker-windows-portable.zip, StudyTracker-windows-web.zip, INSTALL.txt
node_modules/              247M
src-tauri/target/          Rust build cache (gitignored, multi-GB; `cargo clean` or delete freely,
                           the next `npm run tauri build` recreates it)
```

## src/ — frontend (React 19 + TS, ~4.9k lines)

```
main.tsx                   ReactDOM root; in DEV exposes window.__app / window.__timer
App.tsx                    boot gate: phase booting | pick-storage | ready | error
index.css                  ALL styling: design tokens on :root, semantic classes
                           (.btn .input .card .seg .nav-item .menu .dialog .toast .pill
                           .tile .choice .progress .round-btn), then one
                           html[data-skin="…"] block per skin. Components never branch on skin.
types.ts                   DbNode, Session, ChecklistItem, PctHistory, Settings (incl.
                           timer_background / timer_overlay / timer_overlay_tone / timer_background_quality / bell),
                           MediaAsset (name + data: URL), DEFAULT_SETTINGS, RollupMode,
                           SkinId, SUBJECT_COLORS
platform.ts                Tauri-vs-browser shim: homeDir, pickFolder/pickOpenFile/pickSaveFile,
                           ensureDir, writeText/writeBytes/readText, downloadBlob, saveBytes,
                           openPath, notify, backupDatabase, readBytes,
                           playChime(customDataUrl?) — custom bell falls back to the synth chime
```

### src/db/ — storage
```
driver.ts                  SqlDriver interface (select/execute/transaction/close/location)
                           + isTauri()
params.ts                  normalizeParam(): undefined->NULL, bool->0/1, NaN->NULL, Date->ISO (both drivers)
index.ts                   openDatabase(path): picks driver, runs migrate();
                           storage-path memory in localStorage ("studytracker.storage_path");
                           DB_FILENAME = studytracker.db; defaultStoragePath = ~/StudyTracker/…
tauri.ts                   TauriSqlDriver — tauri-plugin-sql; multi-statement writes go
                           through the Rust `sql_batch` command (pool would split BEGIN/COMMIT)
sqljs.ts                   SqlJsDriver — sql.js in the browser, persisted to IndexedDB (debounced,
                           saves chained in order, flushed on pagehide); execute() waits while a
                           transaction is open; nested transaction() joins the outer one;
                           also used in-memory by the tests
migrations.ts              versioned schema via PRAGMA user_version; MIGRATIONS array,
                           CURRENT_SCHEMA_VERSION, migrate() (version bump inside the same
                           transaction as the DDL; refuses newer-schema or foreign SQLite files).
                           Never edit a shipped entry.
repo.ts                    (427 lines) every SQL call: nodes CRUD, setPct (+ pct_history),
                           snapshotSubtree/restoreSubtree (undo), moveNode, duplicateNode,
                           checklist CRUD + checklistPct/syncChecklistPct, sessions
                           (insert/assign/note/delete), loadSettings/saveSetting
```

Tables: `nodes`, `sessions`, `pct_history`, `checklist_items`, `settings` (key/value JSON).

### src/store/ — zustand state (the hub; read these two first)
```
app.ts    (555)  useApp — db handle, nodes/sessions/history/checklist/settings,
                 derived rollup map + root totals, view/selection/expanded/subjectFilter,
                 toasts + undoStack. Actions: boot, chooseStorage, reload, node CRUD,
                 setPct, move/duplicate, checklist, sessions, updateSetting,
                 exportXlsx, importNodes, undo. Also applyTheme() (sets data-skin +
                 .dark on <html>). Debounced CSV mirror write after each mutation.
timer.ts  (294)  useTimer — single vs cycle mode, phase idle/running/paused,
                 blockKind work/break/longbreak, wall-clock endsAt (survives throttling),
                 pause/resume/extend/abort(credit|discard)/skipBreak/stopCycle,
                 tag prompt for untagged sessions. Writes sessions through useApp.
```

### src/lib/ — pure logic (all unit-testable, no React)
```
rollup.ts   computeRollup(nodes, defaultMode) -> Map<id, NodeRollup>; the three rules
            equal | weight | effort; rootTotals, statusFor, hoursPerUnit, subjectIndex
stats.ts    (367) dashboard maths: hoursToday, thisWeekBySubject, timeBySubject,
            plannedVsActual, velocity (+weeks-to-100 forecast), sessionStats, weeklySummary,
            pctAsOf, unassignedHours. UNASSIGNED bucket constant lives here.
time.ts     date-fns helpers; WEEK_STARTS_ON = 1 (Monday); day/week/month keys,
            fmtHours/fmtDuration/fmtClock, relativeDue (today / in 3d / 2d overdue),
            streak, listWeekStarts
treeSort.ts TreeSortKey (manual | priority | due | progress | remaining | name),
            sortSiblings (applied per sibling group, stable on manual order),
            effectiveDeadlines (own date else earliest open descendant), priorityScore
            (remaining effort / days until due)
csv.ts      csvEscape/toCsv, the column lists (NODE_COLUMNS, SESSION_COLUMNS, …),
            per-table csv writers, parseCsv + parseNodesCsv (import)
mirror.ts   mirrorFiles() / writeMirror() — regenerates nodes.csv, sessions.csv,
            pct_history.csv, checklist.csv, weekly_summary.csv. No-op outside Tauri.
xlsx.ts     SheetJS workbook (frozen headers, autofit) for the export
skins.ts    SKINS registry: clean | terminal | soft (label, blurb, swatch)
ids.ts      uid(), nowIso()
media.ts    pickMedia(image|audio) (native dialog in Tauri, <input type=file> in browser),
            shrinkImage (canvas, longest side 1920 for 1080p / 2560 for 2K, JPEG), data: URL helpers, size limits
cn.ts       clsx wrapper
```

### src/components/ — UI, grouped by screen
```
layout/AppShell.tsx        nav + view switch + global keyboard (space, N, E, ⌘Z, Alt+↑/↓ reorder)
tree/TreeView.tsx          flattens nodes into FlatRow[] (sorted per sibling group by
                           useApp.treeSort), sort control, resizable columns + details-pane
                           splitter (widths in localStorage studytracker.tree_cols /
                           tree_detail_w; grid template via --tree-cols on the list container)
tree/TreeRow.tsx           one row: name (only draggable part, manual order only), effort,
                           percent slider/input, checklist chip, Due column (relative label,
                           inherited = earliest open task below), context menu.
                           Exports fmtEffort, shortUnit.
tree/NodeDetail.tsx  (409) right panel: fields, checklist editor, sessions, weekly hours,
                           percent sparkline. Exports StatusPill.
timer/TimerView.tsx        single/cycle controls, presets, abort & tag dialogs; .timer-stage
                           wrapper paints the optional backdrop (blob: URL from the stored
                           data: URL) + overlay; data-tone="dark" re-points colour tokens
timer/Dial.tsx             draggable SVG dial for the duration
inbox/InboxView.tsx        untagged sessions, single and bulk assign
dashboard/DashboardView.tsx (335) today gauge, week-by-subject, stacked time, planned vs
                           actual, velocity, session stats, hour-of-day heatmap (Recharts)
settings/SettingsView.tsx  storage folder, targets, presets, cycle defaults, Focus screen
                           (backdrop, overlay, bell), roll-up rule, skin/theme/sound,
                           CSV mirror, xlsx export, CSV import w/ preview
settings/StoragePicker.tsx first-run folder choice
ui/                        Field/NumberInput, Modal, NodePicker, ProgressBar, RangeSlider,
                           Sparkline, Toasts (Radix primitives underneath)
```

### src/test/
```
acceptance.test.ts (382)   vitest against in-memory sql.js: roll-up rules, checklist,
                           migrations, sessions/cycles/undo, statistics, csv+xlsx round trip,
                           driver transaction serialisation. `npm test`
treeSort.test.ts           tree sort keys, inherited deadlines, priority score, relativeDue
```

## src-tauri/ — desktop shell (Rust)

```
src/lib.rs          commands: sql_batch (all statements in ONE transaction on ONE
                    connection — the SQL plugin pools, so front-end BEGIN/COMMIT can split),
                    home_dir, backup_database (VACUUM INTO snapshot so WAL content is
                    included, then wal_checkpoint; + prune_backups, keeps 7),
                    copy_database (VACUUM INTO, refuses overwrite; used by Settings > Change folder)
src/main.rs         calls lib::run()
Cargo.toml          tauri 2 + plugins sql/fs/dialog/notification/opener
tauri.conf.json     productName StudyTracker, identifier app.studytracker.desktop,
                    window 1280x820, bundles app/dmg/nsis, macOS min 12.0, NSIS per-user
capabilities/default.json  permission allowlist; fs scope $HOME/** etc.
icons/, icon.svg    generated icon set (mac/win/ios/android)
gen/                tauri-generated schemas (gitignored)
```

## Data on disk (desktop)

`~/StudyTracker/` — `studytracker.db` (WAL), the five CSV mirrors, `backups/` (7 daily
copies). Path is remembered in webview localStorage, changeable in Settings.

## Commands

```bash
npm install
npm run dev            # browser mode, http://localhost:1420 (IndexedDB)
npm run tauri dev      # native window (needs Rust)
npm test               # vitest acceptance suite
npm run build          # tsc -b && vite build -> dist/
npm run install:mac    # build .app and copy into /Applications
npm run release:mac    # universal app -> release/StudyTracker-mac.zip
npm run release:web    # browser build -> release/StudyTracker-web.zip
```

Prefer `preview_start` with the `.claude/launch.json` name `studytracker-web` over running
vite from a shell.

## Conventions worth keeping

- Schema changes = a new entry in `MIGRATIONS`; never edit a shipped one.
- All SQL lives in `db/repo.ts`; components go through `useApp`, never touch the driver.
- Styling goes through tokens/semantic classes in `index.css`; no per-skin branching in TSX.
- Pure logic belongs in `src/lib/` so the acceptance suite can cover it.
- Multi-statement desktop writes must use `sql_batch`, not a front-end BEGIN/COMMIT.
- Only a tree row's name is draggable (sliders/inputs keep their pointer gestures); the
  dragged id is module state because WebKit hides custom `dataTransfer` types on dragover.
  Drag & drop is only enabled in manual sort order so the stored order and a column sort
  never fight; other sorts are view-only and never rewrite `sort_order`.
- User media (backdrop, bell) is stored inline as a data: URL in the `settings` table so
  it works in both runtimes and follows the database; images are shrunk on import to keep
  the row a few hundred KB. `sanitizeSettings` drops anything that is not a data: URL.
- Per-device UI preferences (tree sort, column widths, details-pane width) live in
  localStorage under `studytracker.*`, not in the settings table.
