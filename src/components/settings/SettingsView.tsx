import { useRef, useState } from "react";
import { AlertTriangle, Download, FolderOpen, HardDriveDownload, Image as ImageIcon, Music, RefreshCw, Square, Upload, Volume2 } from "lucide-react";
import { useApp } from "../../store/app";
import { Field, NumberInput } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { CURRENT_SCHEMA_VERSION } from "../../db/migrations";
import { copyDatabase, dirname, fileExists, isTauri, openPath, pickFolder, pickOpenFile, pickOpenFiles, readBytes, readText, downloadBlob, joinPath, playChime, stopChime } from "../../platform";
import { dataUrlBytes, fmtBytes, pickMedia, shrinkImage, IMAGE_QUALITIES, IMAGE_QUALITY_LABEL, IMAGE_QUALITY_SIDE, MAX_AUDIO_BYTES } from "../../lib/media";
import { parseNodesCsv, type ImportedNodeRow } from "../../lib/csv";
import { backupCounts, type BackupFile } from "../../lib/backup";
import { backupFromFiles, type PickedFile } from "../../lib/restore";
import { mirrorFiles, writeMirror } from "../../lib/mirror";
import { DB_FILENAME, rememberStoragePath } from "../../db";
import { ROLLUP_MODES, type Settings } from "../../types";
import { ROLLUP_HELP, ROLLUP_LABEL } from "../../lib/rollup";
import { SKINS } from "../../lib/skins";
import { cn } from "../../lib/cn";
import { SqlJsDriver } from "../../db/sqljs";

export function SettingsView() {
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSetting);
  const dbPath = useApp((s) => s.dbPath);
  const nodes = useApp((s) => s.nodes);
  const sessions = useApp((s) => s.sessions);
  const history = useApp((s) => s.history);
  const checklist = useApp((s) => s.checklist);
  const statusHistory = useApp((s) => s.statusHistory);
  const exportXlsx = useApp((s) => s.exportXlsx);
  const importNodes = useApp((s) => s.importNodes);
  const exportBackup = useApp((s) => s.exportBackup);
  const restoreBackup = useApp((s) => s.restoreBackup);
  const schemaVersion = useApp((s) => s.schemaVersion);
  const toast = useApp((s) => s.toast);
  const db = useApp((s) => s.db);

  const [presetsDraft, setPresetsDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportedNodeRow[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ backup: BackupFile; from: string } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [saveFirst, setSaveFirst] = useState(true);

  const setCycle = (patch: Partial<Settings["cycle_defaults"]>) => update("cycle_defaults", { ...settings.cycle_defaults, ...patch });

  const changeFolder = async () => {
    const dir = await pickFolder(dbPath ? dirname(dbPath) : undefined);
    if (!dir) return;
    const target = joinPath(dir, DB_FILENAME);
    if (target === dbPath) return;
    try {
      if (await fileExists(target)) {
        toast("That folder already has a StudyTracker database; opening it. Reloading…");
      } else {
        // Carry the current data over, otherwise the app would open empty and
        // look as if everything had been lost. The old folder is left untouched.
        await copyDatabase(dbPath, target);
        toast("Copied your data to the new folder. Reloading…");
      }
    } catch (e) {
      toast(`Could not switch folder: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    rememberStoragePath(target);
    setTimeout(() => location.reload(), 800);
  };

  const startImport = async () => {
    if (isTauri()) {
      const path = await pickOpenFile([{ name: "CSV", extensions: ["csv"] }]);
      if (!path) return;
      setPreview(parseNodesCsv(await readText(path)));
    } else {
      fileRef.current?.click();
    }
  };

  const readPicked = async (files: PickedFile[], label: string) => {
    try {
      setPending({ backup: await backupFromFiles(files, schemaVersion), from: label });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), undefined, 10000);
    }
  };

  const startRestore = async () => {
    if (isTauri()) {
      const paths = await pickOpenFiles([{ name: "Backup, database or CSV", extensions: ["json", "db", "sqlite", "csv"] }]);
      if (!paths.length) return;
      const files = await Promise.all(paths.map(async (p) => ({ name: p.split(/[\\/]/).pop() ?? p, bytes: await readBytes(p) })));
      await readPicked(files, files.map((f) => f.name).join(", "));
    } else {
      restoreRef.current?.click();
    }
  };

  const applyRestore = async () => {
    if (!pending) return;
    setRestoring(true);
    try {
      // The one irreversible write in the app, so the way out of a mis-picked
      // file is offered before it happens rather than afterwards.
      if (saveFirst) await exportBackup();
      const c = await restoreBackup(pending.backup);
      setPending(null);
      toast(`Restored ${plural(c.nodes, "project or task", "projects and tasks")}, ${plural(c.sessions, "session")}, ${plural(c.history, "history row")}`, undefined, 8000);
    } catch (e) {
      toast(`Restore failed — nothing was changed: ${e instanceof Error ? e.message : String(e)}`, undefined, 12000);
    } finally {
      setRestoring(false);
    }
  };

  const existingIds = new Set(nodes.map((n) => n.id));

  const [busy, setBusy] = useState<"image" | "audio" | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewBell = (data?: string | null) => {
    setPreviewing(true);
    playChime(data, () => setPreviewing(false));
  };
  const chooseBackground = async () => {
    setBusy("image");
    try {
      const picked = await pickMedia("image");
      if (!picked) return;
      const small = await shrinkImage(picked, settings.timer_background_quality);
      await update("timer_background", small);
      toast(`Backdrop set (${fmtBytes(dataUrlBytes(small.data))})`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const chooseBell = async () => {
    setBusy("audio");
    try {
      const picked = await pickMedia("audio");
      if (!picked) return;
      await update("bell", picked);
      previewBell(picked.data);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <Section title="Storage" desc="One SQLite file plus CSV mirrors. Excel and Python can read the CSVs directly while the app is running.">
          <div className="flex items-center gap-2">
            <input className="input flex-1 font-mono text-xs" readOnly value={dbPath || "Browser storage (IndexedDB) — running outside the desktop shell"} />
            {isTauri() && (
              <>
                <button className="btn" onClick={changeFolder}>
                  <FolderOpen size={14} /> Change…
                </button>
                <button className="btn" onClick={() => openPath(dbPath)} title="Reveal in Finder">
                  Reveal
                </button>
              </>
            )}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-xs text-muted">
            <span>Schema v{CURRENT_SCHEMA_VERSION}</span>
            <span>{nodes.length} nodes · {sessions.length} sessions · {history.length} history rows</span>
            <span>Daily backups: last 7 kept in <code>backups/</code></span>
          </div>
          <Field label="CSV mirror" hint="regenerate nodes.csv, sessions.csv, pct_history.csv, weekly_summary.csv on every write" inline>
            <Toggle checked={settings.csv_mirror} onChange={(v) => update("csv_mirror", v)} />
          </Field>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              className="btn"
              onClick={async () => {
                if (isTauri() && dbPath) {
                  await writeMirror(dirname(dbPath), { nodes, sessions, history, checklist, statusHistory, rollupMode: settings.rollup_mode });
                  toast("CSV mirror regenerated");
                } else {
                  for (const [name, text] of Object.entries(mirrorFiles({ nodes, sessions, history, checklist, statusHistory, rollupMode: settings.rollup_mode })))
                    downloadBlob(name, text, "text/csv");
                }
              }}
            >
              <RefreshCw size={14} /> {isTauri() ? "Regenerate CSV mirror now" : "Download CSVs"}
            </button>
            <button
              className="btn"
              onClick={async () => {
                const p = await exportXlsx();
                if (p) toast(`Workbook saved: ${p}`);
              }}
            >
              <Download size={14} /> Export .xlsx
            </button>
            <button className="btn" onClick={startImport}>
              <Upload size={14} /> Merge nodes from CSV…
            </button>
            {!isTauri() && db instanceof SqlJsDriver && (
              <button className="btn" onClick={() => downloadBlob(DB_FILENAME, db.exportBytes(), "application/x-sqlite3")}>
                Download .db
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setPreview(parseNodesCsv(await f.text()));
                e.target.value = "";
              }}
            />
          </div>
        </Section>

        <Section
          title="Backup & restore"
          desc="One file with everything in it: projects, tasks, logged time, history, checklists and settings. Restoring replaces what is in the app now."
        >
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              onClick={async () => {
                try {
                  const p = await exportBackup();
                  if (p) toast(isTauri() ? `Backup saved: ${p}` : `Backup downloaded: ${p}`);
                } catch (e) {
                  toast(`Could not write the backup: ${e instanceof Error ? e.message : String(e)}`, undefined, 10000);
                }
              }}
            >
              <HardDriveDownload size={14} /> Download backup
            </button>
            <button className="btn" onClick={startRestore}>
              <Upload size={14} /> Restore from backup…
            </button>
            <input
              ref={restoreRef}
              type="file"
              multiple
              accept=".json,.db,.sqlite,.csv,application/json,text/csv"
              className="hidden"
              onChange={async (e) => {
                const list = [...(e.target.files ?? [])];
                e.target.value = "";
                if (!list.length) return;
                const files: PickedFile[] = await Promise.all(list.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
                await readPicked(files, files.map((f) => f.name).join(", "));
              }}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            Restore takes the backup <code>.json</code>, a <code>{DB_FILENAME}</code> file, or the exported CSVs — select <code>nodes.csv</code> together with{" "}
            <code>sessions.csv</code> and the rest in one go, and the sessions and history come back with them.
          </p>
        </Section>

        <Section title="Targets">
          <div className="grid grid-cols-2 gap-x-6">
            <Field label="Daily target" hint="hours">
              <NumberInput value={settings.daily_target_hours} min={0} className="input w-full" onChange={(v) => update("daily_target_hours", Math.max(0, v ?? 0))} />
            </Field>
            <Field label="Inbox badge threshold" hint="hours of untagged time">
              <NumberInput value={settings.unassigned_badge_threshold_hours} min={0} className="input w-full" onChange={(v) => update("unassigned_badge_threshold_hours", Math.max(0, v ?? 0))} />
            </Field>
          </div>
        </Section>

        <Section title="Timer">
          <Field label="Single-mode presets" hint="minutes, comma separated">
            <input
              className="input w-full"
              value={presetsDraft ?? settings.timer_presets.join(", ")}
              onChange={(e) => setPresetsDraft(e.target.value)}
              onBlur={() => {
                if (presetsDraft === null) return;
                const list = presetsDraft
                  .split(/[,\s]+/)
                  .map((x) => Number(x))
                  .filter((n) => Number.isFinite(n) && n > 0)
                  .map((n) => Math.round(n));
                if (list.length) update("timer_presets", [...new Set(list)]);
                setPresetsDraft(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </Field>
          <div className="grid grid-cols-5 gap-3">
            <Field label="Work" hint="min">
              <NumberInput value={settings.cycle_defaults.workMinutes} min={1} className="input w-full" onChange={(v) => setCycle({ workMinutes: Math.max(1, v ?? 1) })} />
            </Field>
            <Field label="Break" hint="min">
              <NumberInput value={settings.cycle_defaults.breakMinutes} min={0} className="input w-full" onChange={(v) => setCycle({ breakMinutes: Math.max(0, v ?? 0) })} />
            </Field>
            <Field label="Rounds">
              <NumberInput value={settings.cycle_defaults.rounds} min={1} className="input w-full" onChange={(v) => setCycle({ rounds: Math.max(1, Math.round(v ?? 1)) })} />
            </Field>
            <Field label="Long break every">
              <NumberInput value={settings.cycle_defaults.longBreakEvery} min={0} className="input w-full" onChange={(v) => setCycle({ longBreakEvery: Math.max(0, Math.round(v ?? 0)) })} />
            </Field>
            <Field label="Long break" hint="min">
              <NumberInput value={settings.cycle_defaults.longBreakMinutes} min={0} className="input w-full" onChange={(v) => setCycle({ longBreakMinutes: Math.max(0, v ?? 0) })} />
            </Field>
          </div>
        </Section>

        <Section title="Focus screen" desc="Backdrop and bell for the countdown. Both are stored inside your database, so they follow the storage folder.">
          <Field label="Backdrop resolution" hint="longest side is capped here when you choose an image; re-choose the image to apply a new cap">
            <div className="seg">
              {IMAGE_QUALITIES.map((q) => (
                <button key={q} onClick={() => update("timer_background_quality", q)} className="seg-item" data-active={settings.timer_background_quality === q} style={{ textTransform: "none" }}>
                  {IMAGE_QUALITY_LABEL[q]}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Background image" hint={`JPG, PNG or WebP · shrunk to ${IMAGE_QUALITY_SIDE[settings.timer_background_quality]}px`}>
            <div className="flex items-center gap-3">
              {settings.timer_background ? (
                <img src={settings.timer_background.data} alt="" className="h-14 w-24 shrink-0 rounded-md border border-app object-cover" />
              ) : (
                <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-md border border-app bg-panel-2 text-muted">
                  <ImageIcon size={18} />
                </div>
              )}
              <div className="min-w-0 flex-1 text-xs text-muted">
                {settings.timer_background ? (
                  <>
                    <span className="block truncate text-fg">{settings.timer_background.name}</span>
                    {fmtBytes(dataUrlBytes(settings.timer_background.data))}
                  </>
                ) : (
                  "Plain panel"
                )}
              </div>
              <button className="btn" onClick={chooseBackground} disabled={busy !== null}>
                {busy === "image" ? <RefreshCw size={14} className="animate-spin" /> : <ImageIcon size={14} />} Choose…
              </button>
              {settings.timer_background && (
                <button className="btn btn-ghost" onClick={() => update("timer_background", null)}>
                  Remove
                </button>
              )}
            </div>
          </Field>
          {settings.timer_background && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Overlay" hint="dark keeps text light; light keeps the theme's text">
                <div className="seg">
                  {(["dark", "light"] as const).map((t) => (
                    <button key={t} onClick={() => update("timer_overlay_tone", t)} className="seg-item" data-active={settings.timer_overlay_tone === t}>
                      {t}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Overlay strength" hint={`${Math.round(settings.timer_overlay * 100)}%`}>
                <input
                  type="range"
                  min={0}
                  max={90}
                  step={5}
                  className="w-full"
                  style={{ accentColor: "var(--accent)" }}
                  value={Math.round(settings.timer_overlay * 100)}
                  onChange={(e) => update("timer_overlay", Number(e.target.value) / 100)}
                  aria-label="Overlay strength"
                />
              </Field>
            </div>
          )}
          <Field label="Sound at end of block" inline>
            <Toggle checked={settings.sound} onChange={(v) => update("sound", v)} />
          </Field>
          <Field label="Bell" hint={`MP3, WAV, OGG or M4A · up to ${fmtBytes(MAX_AUDIO_BYTES)}`}>
            <div className="flex items-center gap-3">
              <Music size={16} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-sm">{settings.bell ? settings.bell.name : "Built-in chime"}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => (previewing ? stopChime() : previewBell(settings.bell?.data))} title={previewing ? "Stop" : "Play it"}>
                {previewing ? <Square size={14} /> : <Volume2 size={14} />} {previewing ? "Stop" : "Preview"}
              </button>
              <button className="btn" onClick={chooseBell} disabled={busy !== null}>
                {busy === "audio" ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />} Choose…
              </button>
              {settings.bell && (
                <button className="btn btn-ghost" onClick={() => update("bell", null)}>
                  Reset
                </button>
              )}
            </div>
          </Field>
        </Section>

        <Section title="Roll-up" desc="How a parent's percent is computed from its children. Any project or group can override this from its detail panel.">
          <div className="grid gap-2 md:grid-cols-3">
            {ROLLUP_MODES.map((m) => (
              <button key={m} className="choice" data-active={settings.rollup_mode === m} onClick={() => update("rollup_mode", m)}>
                <span className="block text-sm font-medium">{ROLLUP_LABEL[m]}</span>
                <span className="mt-0.5 block text-xs text-muted">{ROLLUP_HELP[m]}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Appearance" desc="Skins restyle the whole app; your data and layout stay the same.">
          <Field label="Skin">
            <div className="grid gap-2 sm:grid-cols-3">
              {SKINS.map((s) => (
                <button key={s.id} className="choice flex items-center gap-3" data-active={settings.skin === s.id} onClick={() => update("skin", s.id)}>
                  <span className="swatch shrink-0" aria-hidden>
                    {s.swatch.map((c, i) => (
                      <span key={i} style={{ background: c }} />
                    ))}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{s.label}</span>
                    <span className="block text-xs text-muted">{s.blurb}</span>
                  </span>
                </button>
              ))}
            </div>
          </Field>
          <Field label="Theme" inline>
            <div className="seg">
              {(["system", "light", "dark"] as const).map((t) => (
                <button key={t} onClick={() => update("theme", t)} className="seg-item" data-active={settings.theme === t}>
                  {t}
                </button>
              ))}
            </div>
          </Field>
        </Section>
      </div>

      <Modal
        open={pending !== null}
        onOpenChange={(o) => !o && !restoring && setPending(null)}
        title="Restore from backup"
        description="Everything currently in StudyTracker is replaced by the contents of this file. This cannot be undone."
        footer={
          <>
            <button className="btn" disabled={restoring} onClick={() => setPending(null)}>
              Cancel
            </button>
            <button className="btn btn-danger" disabled={restoring} onClick={applyRestore}>
              {restoring ? "Restoring…" : "Replace everything"}
            </button>
          </>
        }
      >
        {pending && (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-xs text-muted">
              From <span className="font-mono">{pending.from}</span>
              {pending.backup.exported_at ? ` · exported ${pending.backup.exported_at.slice(0, 16).replace("T", " ")}` : ""}
            </p>
            <table className="w-full text-xs">
              <thead className="table-head text-left">
                <tr>
                  <th className="px-2 py-1"> </th>
                  <th className="px-2 py-1 text-right">In the app now</th>
                  <th className="px-2 py-1 text-right">After restoring</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Projects and tasks", nodes.length, backupCounts(pending.backup).nodes],
                    ["Sessions", sessions.length, backupCounts(pending.backup).sessions],
                    ["History rows", history.length + statusHistory.length, backupCounts(pending.backup).history],
                    ["Checklist items", checklist.length, backupCounts(pending.backup).checklist],
                  ] as const
                ).map(([label, before, after]) => (
                  <tr key={label} className="border-t border-app">
                    <td className="px-2 py-1">{label}</td>
                    <td className="px-2 py-1 text-right text-muted">{before}</td>
                    <td className="px-2 py-1 text-right font-medium">{after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {backupCounts(pending.backup).settings === 0 && (
              <p className="flex items-start gap-1.5 text-xs text-muted">
                <AlertTriangle size={13} className="mt-px shrink-0" />
                This file carries no settings, so targets, timer presets and the backdrop stay as they are now.
              </p>
            )}
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={saveFirst} onChange={(e) => setSaveFirst(e.target.checked)} />
              {isTauri() ? "Save a backup of my current data first" : "Download a backup of my current data first"}
            </label>
          </div>
        )}
      </Modal>

      <Modal
        open={preview !== null}
        onOpenChange={(o) => !o && setPreview(null)}
        title="Import nodes from CSV"
        description="Rows with an id that already exists are updated; the rest are created. Nothing is written until you confirm."
        width="max-w-3xl"
        footer={
          <>
            <button className="btn" onClick={() => setPreview(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!preview?.length}
              onClick={async () => {
                if (!preview) return;
                try {
                  const r = await importNodes(preview);
                  toast(`Imported: ${r.created} created, ${r.updated} updated`);
                  setPreview(null);
                } catch (e) {
                  toast(`Import failed: ${e instanceof Error ? e.message : e}`);
                }
              }}
            >
              Apply {preview?.length ?? 0} row{preview?.length === 1 ? "" : "s"}
            </button>
          </>
        }
      >
        {preview && (
          <div className="max-h-80 overflow-auto rounded border border-app">
            <table className="w-full text-xs">
              <thead className="table-head sticky top-0 bg-panel-2 text-left">
                <tr>
                  <th className="px-2 py-1">Action</th>
                  <th className="px-2 py-1">Name</th>
                  <th className="px-2 py-1">Parent</th>
                  <th className="px-2 py-1 text-right">Est.</th>
                  <th className="px-2 py-1 text-right">%</th>
                  <th className="px-2 py-1">Unit</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r, i) => {
                  const exists = r.id && existingIds.has(r.id);
                  return (
                    <tr key={i} className="border-t border-app">
                      <td className={cn("px-2 py-1 font-medium", exists ? "text-warn" : "text-ok")}>{exists ? "update" : "create"}</td>
                      <td className="px-2 py-1">{r.name}</td>
                      <td className="px-2 py-1 text-muted">{r.parent_id ? nodes.find((n) => n.id === r.parent_id)?.name ?? r.parent_id.slice(0, 8) : "(project)"}</td>
                      <td className="px-2 py-1 text-right">{r.est_effort ?? ""}</td>
                      <td className="px-2 py-1 text-right">{r.pct_complete ?? ""}</td>
                      <td className="px-2 py-1">{r.unit ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2 className="section-title">{title}</h2>
      {desc && <p className="mt-0.5 text-xs text-muted">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="switch">
      <span className="switch-thumb" />
    </button>
  );
}
