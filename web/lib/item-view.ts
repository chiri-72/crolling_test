import {
  extractUrls,
  isMeaningfulSummary,
  normalizeTitle,
  sanitizeSummaryForDisplay,
} from "@/lib/text";

interface TranslationLike {
  title_translated?: string | null;
  summary_translated?: string | null;
}

interface ItemLike {
  title?: string | null;
  canonical_url?: string | null;
  summary?: string | null;
  raw?: Record<string, unknown> | null;
}

interface SourceLike {
  name?: string | null;
  type?: string | null;
}

type SourceKind = "hackernews" | "techcrunch" | "youtube" | "generic";

export function buildViewData(item: ItemLike, tr?: TranslationLike, source?: SourceLike) {
  const rawObj = item.raw ?? {};
  const canonicalUrl = normalizeTitle(item.canonical_url ?? "");
  const rawSummary = normalizeTitle(item.summary ?? "");
  const trSummary = normalizeTitle(tr?.summary_translated ?? "");
  const fallbackUrls = extractUrls(`${rawSummary}\n${JSON.stringify(rawObj)}`);
  const rawLink = normalizeTitle(readString(rawObj.link));
  const sourceKind = detectSourceKind(source?.name, source?.type);

  let articleUrl = canonicalUrl;
  let commentsUrl = "";

  if (sourceKind === "youtube") {
    articleUrl = canonicalUrl || rawLink;
    commentsUrl = "";
  } else if (sourceKind === "hackernews") {
    const labeledArticle = parseLabeledUrl(rawSummary, "Article URL");
    const labeledComments = parseLabeledUrl(rawSummary, "Comments URL");
    const nonHnUrl = fallbackUrls.find((u) => !isHnDiscussionUrl(u)) ?? "";
    articleUrl = labeledArticle ?? nonHnUrl ?? "";
    commentsUrl = labeledComments
      ?? (isHnDiscussionUrl(canonicalUrl) ? canonicalUrl : "")
      ?? (isHnDiscussionUrl(rawLink) ? rawLink : "");
  } else if (sourceKind === "techcrunch") {
    articleUrl = canonicalUrl || rawLink;
    commentsUrl = "";
  } else {
    articleUrl = canonicalUrl || rawLink;
    commentsUrl = isHnDiscussionUrl(canonicalUrl) ? canonicalUrl : "";
  }

  const originalSummary = isMeaningfulSummary(rawSummary)
    ? sanitizeSummaryForDisplay(rawSummary)
    : "";
  const translatedSummary = isMeaningfulSummary(trSummary)
    ? sanitizeSummaryForDisplay(trSummary)
    : "";

  const points = parseNumber(rawSummary, /Points:\s*(\d+)/i);
  const comments = parseNumber(rawSummary, /(?:#\s*)?Comments:\s*(\d+)/i);
  const categories = readStringArray(rawObj.categories);
  const youtubeVideoId = readString(rawObj.video_id) || extractYoutubeVideoId(articleUrl);
  const youtubeEmbedUrl =
    readString(rawObj.embed_url) ||
    (youtubeVideoId ? `https://www.youtube.com/embed/${youtubeVideoId}` : "");
  const youtubeThumbnailUrl = readString(rawObj.thumbnail_url);

  return {
    titleOriginal: normalizeTitle(item.title ?? ""),
    titleKo: normalizeTitle(tr?.title_translated ?? ""),
    summaryOriginal: originalSummary,
    summaryKo: translatedSummary,
    articleUrl: ensureHttp(articleUrl),
    commentsUrl: ensureHttp(commentsUrl),
    fallbackUrl: ensureHttp(fallbackUrls[0] ?? ""),
    points: points ?? null,
    comments: comments ?? null,
    categories,
    sourceKind,
    youtubeVideoId: youtubeVideoId || null,
    youtubeEmbedUrl: ensureHttp(youtubeEmbedUrl),
    youtubeThumbnailUrl: ensureHttp(youtubeThumbnailUrl),
  };
}

function parseLabeledUrl(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}:\\s*(https?:\\/\\/\\S+)`, "i");
  const m = text.match(re);
  return m?.[1] ?? null;
}

function parseNumber(text: string, re: RegExp): number | null {
  const m = text.match(re);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function ensureHttp(url: string): string {
  if (!url) return "";
  return /^https?:\/\//.test(url) ? url : "";
}

function isHnDiscussionUrl(url: string): boolean {
  return /news\.ycombinator\.com\/item\?id=\d+/i.test(url);
}

function detectSourceKind(name: string | null | undefined, type: string | null | undefined): SourceKind {
  const t = (type ?? "").toLowerCase();
  if (t === "youtube") return "youtube";
  const n = (name ?? "").toLowerCase();
  if (n.includes("hacker news")) return "hackernews";
  if (n.includes("techcrunch")) return "techcrunch";
  if (n.includes("youtube")) return "youtube";
  if (n.includes("podcast")) return "youtube";
  return "generic";
}

function extractYoutubeVideoId(url: string): string {
  const u = safeUrl(url);
  if (!u) return "";
  if (u.hostname.includes("youtube.com")) return u.searchParams.get("v") ?? "";
  if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "");
  return "";
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}
