import { createServerClient } from "@/lib/supabase";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { buildViewData } from "@/lib/item-view";
import { normalizeTitle } from "@/lib/text";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ItemDetailPage({ params }: Props) {
  const { id } = await params;
  const supabase = createServerClient();

  const { data: item } = await supabase
    .from("items")
    .select(`
      *,
      sources(name, type, base_url),
      item_translations(title_translated, summary_translated, provider, model, tokens_used, translated_at)
    `)
    .eq("id", id)
    .single();

  if (!item) return notFound();

  const source = item.sources as unknown as { name: string; type: string; base_url: string | null } | null;
  const tr = item.item_translations?.[0] as
    | {
        title_translated?: string | null;
        summary_translated?: string | null;
        provider?: string | null;
        model?: string | null;
        tokens_used?: number | null;
        translated_at?: string | null;
      }
    | undefined;
  const view = buildViewData(item, tr, source ?? undefined);
  const originalTitle = view.titleOriginal;
  const hasTitleTranslation = Boolean(tr?.title_translated?.trim());
  const hasSummaryTranslation = Boolean(tr?.summary_translated?.trim());
  const translatedTitle = hasTitleTranslation ? view.titleKo : "";
  const originalSummary = view.summaryOriginal;
  const translatedSummary = view.summaryKo;
  const canonicalUrl = view.articleUrl || normalizeTitle(item.canonical_url);
  const discussionUrl = view.commentsUrl;
  const author = normalizeTitle(item.author);
  const hasCanonicalUrl = /^https?:\/\//.test(canonicalUrl);
  const hasDiscussionUrl = /^https?:\/\//.test(discussionUrl);
  const hasEmbed = view.sourceKind === "youtube" && /^https?:\/\/www\.youtube\.com\/embed\//.test(view.youtubeEmbedUrl ?? "");
  const valueOrDash = (v: string | null | undefined) => (v && v.trim() ? v : "-");

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/" className="mb-4 inline-block text-sm text-gray-500 hover:text-gray-900">
        &larr; Back
      </Link>

      <article className="rounded-xl border bg-white p-6">
        {/* Source badge */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span className="rounded bg-gray-100 px-2 py-0.5 font-medium">{valueOrDash(source?.name)}</span>
          <span>by {valueOrDash(author)}</span>
          {item.published_at && (
            <span>{new Date(item.published_at).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" })}</span>
          )}
        </div>

        {/* Title */}
        <h1 className="text-sm text-gray-500">{originalTitle}</h1>
        <h2 className="mt-1 text-xl font-bold">
          {translatedTitle || (hasSummaryTranslation ? originalTitle : <span className="text-amber-500">번역 대기</span>)}
        </h2>

        {hasEmbed && (
          <div className="mt-4 overflow-hidden rounded-lg border bg-black">
            <iframe
              src={view.youtubeEmbedUrl ?? ""}
              title={originalTitle || "YouTube video"}
              className="aspect-video w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
        )}

        <hr className="my-4" />

        {/* Summary */}
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase text-gray-400">Original Summary</h3>
            <p className="whitespace-pre-wrap text-sm text-gray-700">{valueOrDash(originalSummary)}</p>
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase text-gray-400">번역 요약</h3>
            <p className="whitespace-pre-wrap text-sm text-gray-900">{valueOrDash(translatedSummary)}</p>
          </div>
        </div>

        <hr className="my-4" />

        {/* Meta */}
        <div className="grid gap-2 rounded-lg border bg-gray-50 p-4 text-sm text-gray-700 md:grid-cols-2">
          <MetaRow label="Source">{valueOrDash(source?.name)}</MetaRow>
          <MetaRow label="Language">{valueOrDash(item.language)}</MetaRow>
          <MetaRow label="Author">{valueOrDash(author)}</MetaRow>
          <MetaRow label="Published at">
            {item.published_at ? new Date(item.published_at).toLocaleString("ko-KR") : "-"}
          </MetaRow>
          <MetaRow label="Points">{view.points != null ? String(view.points) : "-"}</MetaRow>
          <MetaRow label="Comments">{view.comments != null ? String(view.comments) : "-"}</MetaRow>
          <MetaRow label="Categories">
            {view.categories.length > 0 ? view.categories.join(", ") : "-"}
          </MetaRow>
          <MetaRow label="Translated by">
            {tr ? `${valueOrDash(tr.provider)}/${valueOrDash(tr.model)}` : "-"}
          </MetaRow>
          <MetaRow label="Translated at">
            {tr?.translated_at ? new Date(tr.translated_at).toLocaleString("ko-KR") : "-"}
          </MetaRow>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {hasCanonicalUrl ? (
            <a
              href={canonicalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
            >
              원문 링크
            </a>
          ) : (
            <span className="inline-flex items-center rounded bg-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600">원문 링크 -</span>
          )}
          {hasDiscussionUrl ? (
            <a
              href={discussionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded border px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              토론 링크
            </a>
          ) : (
            <span className="inline-flex items-center rounded border px-3 py-1.5 text-xs font-medium text-gray-500">토론 링크 -</span>
          )}
        </div>

        <details className="mt-4 rounded-lg border bg-gray-50">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-gray-700">
            Raw payload
          </summary>
          <pre className="max-h-80 overflow-auto border-t p-3 text-[11px] leading-relaxed text-gray-700">
            {JSON.stringify(item.raw, null, 2)}
          </pre>
        </details>
      </article>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p>
      <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
      <span>{children}</span>
    </p>
  );
}
