import { createServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const supabase = createServerClient();

  const { data: sources } = await supabase
    .from("sources")
    .select("*")
    .order("priority", { ascending: false });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Sources</h1>

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3">Seed URL</th>
              <th className="px-4 py-3">Max Items</th>
              <th className="px-4 py-3">Recency</th>
              <th className="px-4 py-3">Block KW</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {(sources ?? []).map((s) => {
              const policy = s.crawl_policy ?? {};
              return (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">
                    <a href={s.base_url ?? s.seed_url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {s.name}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">{s.type}</span>
                  </td>
                  <td className="px-4 py-3">{s.priority}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${s.is_active ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"}`}>
                      {s.is_active ? "active" : "disabled"}
                    </span>
                  </td>
                  <td className="max-w-72 truncate px-4 py-3 text-xs text-gray-600">{s.seed_url}</td>
                  <td className="px-4 py-3">{policy.max_items_per_run ?? 30}</td>
                  <td className="px-4 py-3">{policy.recency_days ?? 7}d</td>
                  <td className="px-4 py-3">{(policy.block_keywords ?? []).length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
