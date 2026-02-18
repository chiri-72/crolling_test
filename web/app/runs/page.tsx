import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const STATUS_COLORS: Record<string, string> = {
  success: "bg-green-50 text-green-700",
  partial_fail: "bg-amber-50 text-amber-700",
  fail: "bg-red-50 text-red-700",
  running: "bg-blue-50 text-blue-700",
};

const LEVEL_COLORS: Record<string, string> = {
  info: "text-gray-500",
  warn: "text-amber-600",
  error: "text-red-600",
};

export default async function RunsPage() {
  const supabase = createServerClient();

  const { data: runs } = await supabase
    .from("crawl_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(20);

  // Get logs for all runs
  const runIds = (runs ?? []).map((r: { id: string }) => r.id);
  const { data: logs } = runIds.length > 0
    ? await supabase
        .from("crawl_logs")
        .select("*")
        .in("run_id", runIds)
        .order("created_at", { ascending: true })
    : { data: [] };

  const logsByRun = new Map<string, typeof logs>();
  for (const log of logs ?? []) {
    const arr = logsByRun.get(log.run_id) ?? [];
    arr.push(log);
    logsByRun.set(log.run_id, arr);
  }

  const total = runs?.length ?? 0;
  const success = (runs ?? []).filter((r: { status: string }) => r.status === "success").length;
  const failed = (runs ?? []).filter((r: { status: string }) => r.status === "fail").length;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Crawl Runs</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs uppercase text-gray-500">Recent Runs</p>
          <p className="mt-1 text-2xl font-bold">{total}</p>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs uppercase text-gray-500">Success</p>
          <p className="mt-1 text-2xl font-bold text-emerald-700">{success}</p>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <p className="text-xs uppercase text-gray-500">Fail</p>
          <p className="mt-1 text-2xl font-bold text-red-700">{failed}</p>
        </div>
      </div>

      <div className="space-y-4">
        {(runs ?? []).length === 0 && (
          <p className="py-12 text-center text-gray-400">No crawl runs yet.</p>
        )}

        {(runs ?? []).map((run) => {
          const runLogs = logsByRun.get(run.id) ?? [];
          const duration =
            run.ended_at && run.started_at
              ? Math.max(
                  1,
                  Math.round(
                    (new Date(run.ended_at).getTime() - new Date(run.started_at).getTime()) / 1000
                  )
                )
              : null;
          return (
            <details key={run.id} className="rounded-xl border bg-white">
              <summary className="cursor-pointer px-4 py-3 hover:bg-gray-50">
                <div className="inline-flex items-center gap-3">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[run.status] ?? ""}`}>
                    {run.status}
                  </span>
                  <span className="text-sm font-medium">
                    {new Date(run.started_at).toLocaleString("ko-KR")}
                  </span>
                  <span className="text-xs text-gray-500">
                    Sources: {run.total_sources} | Found: {run.items_found} | Saved: {run.items_saved} | Translated: {run.items_translated} | Duration: {duration ? `${duration}s` : "-"}
                  </span>
                  {run.error_count > 0 && (
                    <span className="text-xs text-red-500">Errors: {run.error_count}</span>
                  )}
                </div>
              </summary>

              <div className="border-t px-4 py-3">
                {runLogs.length === 0 && (
                  <p className="text-sm text-gray-400">No logs.</p>
                )}
                <div className="space-y-1">
                  {runLogs.map((log) => (
                    <div key={log.id} className={`text-xs font-mono ${LEVEL_COLORS[log.level] ?? ""}`}>
                      <span className="uppercase">[{log.level}]</span>{" "}
                      {log.message}
                      {log.meta && Object.keys(log.meta).length > 0 && (
                        <span className="ml-2 text-gray-400">
                          {JSON.stringify(log.meta)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
