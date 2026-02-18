import { createServerClient } from "@/lib/supabase";
import Link from "next/link";
import { buildViewData } from "@/lib/item-view";
import { normalizeTitle } from "@/lib/text";

interface Props {
  searchParams: Promise<{
    source?: string;
    period?: string;
    q?: string;
    t?: string;
    page?: string;
  }>;
}

const PAGE_SIZE = 20;

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: Props) {
  const params = await searchParams;
  const supabase = createServerClient();
  const page = Math.max(1, parseInt(params.page ?? "1"));
  const offset = (page - 1) * PAGE_SIZE;

  const translationFilter = params.t ?? "all";

  // Build query (items + source + translation)
  let query = supabase
    .from("items")
    .select(
      `id, title, summary, author, published_at, canonical_url, source_id, raw,
       sources!inner(name, type),
       item_translations(title_translated, summary_translated)`,
      { count: "exact" }
    )
    .order("published_at", { ascending: false, nullsFirst: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (params.source) {
    query = query.eq("source_id", params.source);
  }
  if (params.period) {
    const cutoff = new Date();
    if (params.period === "24h") cutoff.setHours(cutoff.getHours() - 24);
    else if (params.period === "7d") cutoff.setDate(cutoff.getDate() - 7);
    else if (params.period === "30d") cutoff.setDate(cutoff.getDate() - 30);
    query = query.gte("published_at", cutoff.toISOString());
  }
  if (params.q) {
    query = query.or(`title.ilike.%${params.q}%,summary.ilike.%${params.q}%`);
  }
  if (translationFilter === "translated") {
    query = query.or(
      "title_translated.not.is.null,summary_translated.not.is.null",
      { foreignTable: "item_translations" }
    );
  }
  if (translationFilter === "pending") {
    query = query.is("item_translations.title_translated", null);
    query = query.is("item_translations.summary_translated", null);
  }

  const { data: items, count } = await query;
  const totalPages = Math.ceil((count ?? 0) / PAGE_SIZE);

  // Sources for filter
  const { data: sources } = await supabase
    .from("sources")
    .select("id, name, is_active")
    .order("priority", { ascending: false });

  // Dashboard cards
  const [{ count: totalItems }, { count: totalTranslations }, { data: latestRun }, { data: activeSources }] =
    await Promise.all([
      supabase.from("items").select("*", { count: "exact", head: true }),
      supabase
        .from("item_translations")
        .select("*", { count: "exact", head: true })
        .eq("lang", "ko"),
      supabase
        .from("crawl_runs")
        .select("id, status, started_at, items_found, items_saved, items_translated")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from("sources").select("id").eq("is_active", true),
    ]);

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="전체 아이템" value={String(totalItems ?? 0)} />
        <Card label="번역 완료" value={String(totalTranslations ?? 0)} />
        <Card
          label="활성 소스"
          value={`${activeSources?.length ?? 0}/${sources?.length ?? 0}`}
        />
        <Card
          label="최근 실행"
          value={latestRun ? latestRun.status : "no-run"}
          sub={
            latestRun
              ? `${new Date(latestRun.started_at).toLocaleString("ko-KR")} · found ${latestRun.items_found} / saved ${latestRun.items_saved}`
              : "crawl_runs 데이터 없음"
          }
        />
      </section>

      {/* Filter Bar */}
      <form className="flex flex-wrap gap-3 rounded-xl border bg-white p-4">
        <select
          name="source"
          defaultValue={params.source ?? ""}
          className="rounded border px-3 py-1.5 text-sm"
        >
          <option value="">All Sources</option>
          {(sources ?? []).map((s: { id: string; name: string }) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <select
          name="t"
          defaultValue={translationFilter}
          className="rounded border px-3 py-1.5 text-sm"
        >
          <option value="all">All Translations</option>
          <option value="translated">Translated</option>
          <option value="pending">Pending</option>
        </select>

        <div className="flex gap-1">
          {["24h", "7d", "30d", "all"].map((p) => (
            <Link
              key={p}
              href={buildPeriodUrl(params, p, translationFilter)}
              className={`rounded px-3 py-1.5 text-sm ${
                (p === "all" ? !params.period : params.period === p)
                  ? "bg-gray-900 text-white"
                  : "border hover:bg-gray-100"
              }`}
            >
              {p}
            </Link>
          ))}
        </div>

        <input
          type="text"
          name="q"
          defaultValue={params.q ?? ""}
          placeholder="Search title / summary..."
          className="flex-1 rounded border px-3 py-1.5 text-sm"
        />
        <button type="submit" className="rounded bg-gray-900 px-4 py-1.5 text-sm text-white hover:bg-gray-700">
          Search
        </button>
      </form>

      {/* Item List */}
      <div className="space-y-3">
        {(items ?? []).length === 0 && (
          <p className="py-12 text-center text-gray-400">No items found.</p>
        )}

        {(items ?? []).map((item) => {
          const source = item.sources as unknown as { name: string } | null;
          const tr = item.item_translations?.[0] as
            | { title_translated?: string | null; summary_translated?: string | null }
            | undefined;
          const pubDate = item.published_at ? new Date(item.published_at) : null;
          const hasTitleTranslation = Boolean(tr?.title_translated?.trim());
          const hasSummaryTranslation = Boolean(tr?.summary_translated?.trim());
          const isTranslated = hasTitleTranslation || hasSummaryTranslation;
          const view = buildViewData(item, tr, source ?? undefined);
          const originalTitle = view.titleOriginal;
          const translatedTitle = hasTitleTranslation ? view.titleKo : "";
          const summary = view.summaryKo || view.summaryOriginal;
          const articleUrl = view.articleUrl || normalizeTitle(item.canonical_url ?? "");
          const hasOriginalUrl = /^https?:\/\//.test(articleUrl);
          const isYoutube = view.sourceKind === "youtube";
          const hasEmbed = view.sourceKind === "youtube" && /^https?:\/\/www\.youtube\.com\/embed\//.test(view.youtubeEmbedUrl ?? "");
          const hasThumbnail = isYoutube && /^https?:\/\//.test(view.youtubeThumbnailUrl ?? "");

          return (
            <article
              key={item.id}
              className="rounded-xl border bg-white p-4 transition hover:shadow-md"
            >
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                {source && <span className="rounded bg-gray-100 px-2 py-0.5 font-medium">{source.name}</span>}
                {pubDate && <span>{getTimeAgo(pubDate)}</span>}
                {isYoutube ? (
                  <span className="rounded bg-red-50 px-2 py-0.5 font-medium text-red-700">VIDEO</span>
                ) : (
                  <span className="rounded bg-blue-50 px-2 py-0.5 font-medium text-blue-700">ARTICLE</span>
                )}
                <span
                  className={`rounded px-2 py-0.5 font-medium ${
                    isTranslated ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {isTranslated ? "translated" : "pending"}
                </span>
              </div>
              {isYoutube && hasThumbnail && (
                <div className="mb-3 overflow-hidden rounded-lg border bg-gray-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={view.youtubeThumbnailUrl ?? ""}
                    alt={originalTitle || "YouTube thumbnail"}
                    className="aspect-video w-full object-cover"
                    loading="lazy"
                  />
                </div>
              )}
              <h2 className="text-sm text-gray-500">{originalTitle}</h2>
              <h3 className="mt-0.5 font-semibold">
                {translatedTitle || <span className="text-amber-500 text-sm">번역 대기</span>}
              </h3>
              <p className="mt-1 line-clamp-2 text-sm text-gray-600">{summary || "-"}</p>
              <div className="mt-3 flex items-center gap-2">
                <Link
                  href={`/item/${item.id}`}
                  className="rounded border px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  상세 보기
                </Link>
                {hasOriginalUrl && (
                  <a
                    href={articleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded bg-gray-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-gray-700"
                  >
                    {hasEmbed ? "영상 열기" : "원문 열기"}
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-2">
          {page > 1 && (
            <Link href={buildUrl(params, page - 1)} className="rounded border px-3 py-1 text-sm hover:bg-gray-100">Prev</Link>
          )}
          <span className="text-sm text-gray-500">{page} / {totalPages}</span>
          {page < totalPages && (
            <Link href={buildUrl(params, page + 1)} className="rounded border px-3 py-1 text-sm hover:bg-gray-100">Next</Link>
          )}
        </div>
      )}
    </div>
  );
}

function getTimeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("ko-KR");
}

function buildUrl(p: Record<string, string | undefined>, page: number): string {
  const sp = new URLSearchParams();
  if (p.source) sp.set("source", p.source);
  if (p.period) sp.set("period", p.period);
  if (p.q) sp.set("q", p.q);
  if (p.t) sp.set("t", p.t);
  sp.set("page", String(page));
  return `/?${sp.toString()}`;
}

function buildPeriodUrl(
  p: Record<string, string | undefined>,
  period: string,
  translationFilter: string,
): string {
  const sp = new URLSearchParams();
  if (p.source) sp.set("source", p.source);
  if (p.q) sp.set("q", p.q);
  if (translationFilter !== "all") sp.set("t", translationFilter);
  if (period !== "all") sp.set("period", period);
  return `/?${sp.toString()}`;
}

function Card({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {sub && <p className="mt-1 line-clamp-2 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}
