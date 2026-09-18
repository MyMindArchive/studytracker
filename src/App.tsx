import { useEffect } from "react";
import { useApp } from "./store/app";
import { useTimer } from "./store/timer";
import { AppShell } from "./components/layout/AppShell";
import { StoragePicker } from "./components/settings/StoragePicker";
import { Toasts } from "./components/ui/Toasts";

export default function App() {
  const phase = useApp((s) => s.phase);
  const error = useApp((s) => s.error);
  const boot = useApp((s) => s.boot);

  useEffect(() => {
    boot();
  }, [boot]);

  useEffect(() => {
    if (phase === "ready") useTimer.getState().loadDefaults();
  }, [phase]);

  if (phase === "booting") {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <div className="animate-pulse text-sm">Opening StudyTracker…</div>
      </div>
    );
  }
  if (phase === "pick-storage") return <StoragePicker />;
  if (phase === "error") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="card max-w-lg">
          <h1 className="h1 text-lg text-danger">Could not open the database</h1>
          <pre className="mt-3 whitespace-pre-wrap text-xs text-muted">{error}</pre>
          <div className="mt-4 flex gap-2">
            <button className="btn" onClick={() => location.reload()}>
              Retry
            </button>
            <button
              className="btn"
              onClick={() => {
                localStorage.removeItem("studytracker.storage_path");
                location.reload();
              }}
            >
              Choose another folder
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <>
      <AppShell />
      <Toasts />
    </>
  );
}
