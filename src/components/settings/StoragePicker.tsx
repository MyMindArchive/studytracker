import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useApp } from "../../store/app";
import { defaultStoragePath, DB_FILENAME } from "../../db";
import { dirname, joinPath, pickFolder } from "../../platform";

export function StoragePicker() {
  const choose = useApp((s) => s.chooseStorage);
  const [path, setPath] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    defaultStoragePath().then(setPath);
  }, []);

  const browse = async () => {
    const dir = await pickFolder(dirname(path));
    if (dir) setPath(joinPath(dir, DB_FILENAME));
  };

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="card w-full max-w-lg">
        <h1 className="h1 text-lg">Where should StudyTracker keep your data?</h1>
        <p className="mt-1 text-sm text-muted">
          A single SQLite file plus CSV mirrors (nodes, sessions, pct_history, weekly_summary) live in this folder. You can open them
          directly in Excel or Python at any time. Nothing leaves your machine.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <input className="input flex-1 font-mono text-xs" value={path} onChange={(e) => setPath(e.target.value)} />
          <button className="btn" onClick={browse}>
            <FolderOpen size={14} /> Browse
          </button>
        </div>
        <div className="mt-5 flex justify-end">
          <button
            className="btn btn-primary"
            disabled={!path || busy}
            onClick={async () => {
              setBusy(true);
              await choose(path);
              setBusy(false);
            }}
          >
            {busy ? "Opening…" : "Use this folder"}
          </button>
        </div>
      </div>
    </div>
  );
}
