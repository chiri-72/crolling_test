import Parser from "rss-parser";
import type { RawItem } from "./types";
import type { CrawlPolicy } from "@/lib/types";
import { normalizeSummaryText, normalizeTitle, sanitizeSummaryForDisplay } from "@/lib/text";

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "StartupFeed/1.0 (YouTube RSS Reader)",
  },
});

export async function fetchYoutube(seedUrl: string, policy: CrawlPolicy): Promise<RawItem[]> {
  const feedUrl = await resolveYouTubeFeedUrl(seedUrl);
  const feed = await parser.parseURL(feedUrl);
  const maxItems = policy.max_items_per_run ?? 20;

  return (feed.items ?? [])
    .filter((entry) => !isYouTubeShortsUrl(entry.link))
    .slice(0, maxItems)
    .map((entry) => {
      const raw = entry as unknown as Record<string, unknown>;
      const videoId = extractVideoId(raw, entry.link);
      const channelId = extractChannelId(raw);
      const canonicalUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : (entry.link ?? "");
      const summary = toStoredSummary(readString(raw["media:group"]) || entry.contentSnippet || "");
      const thumbnail = extractThumbnail(raw);

      return {
        title: normalizeTitle(entry.title ?? ""),
        canonical_url: canonicalUrl,
        summary,
        author: normalizeTitle(entry.author ?? ""),
        published_at: entry.isoDate ?? undefined,
        source_item_id: videoId ?? entry.guid ?? entry.link ?? undefined,
        language: "en",
        raw: {
          ...raw,
          source_kind: "youtube",
          video_id: videoId ?? null,
          channel_id: channelId ?? null,
          embed_url: videoId ? `https://www.youtube.com/embed/${videoId}` : null,
          thumbnail_url: thumbnail ?? null,
          source_feed_url: feedUrl,
        },
      };
    });
}

function isYouTubeShortsUrl(url?: string): boolean {
  if (!url) return false;
  const parsed = safeUrl(url);
  if (!parsed) return false;
  return parsed.hostname.includes("youtube.com") && parsed.pathname.startsWith("/shorts/");
}

async function resolveYouTubeFeedUrl(seedUrl: string): Promise<string> {
  if (seedUrl.includes("feeds/videos.xml")) return seedUrl;
  const normalized = normalizeYouTubeUrl(seedUrl);
  const channelIdFromUrl = extractChannelIdFromUrl(normalized);
  if (channelIdFromUrl) return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelIdFromUrl}`;

  const html = await fetchChannelHtml(normalized);
  const channelIdFromHtml = extractChannelIdFromHtml(html);
  if (!channelIdFromHtml) {
    throw new Error(`Unable to resolve YouTube channel_id from seed_url: ${seedUrl}`);
  }
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelIdFromHtml}`;
}

function normalizeYouTubeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.endsWith("/videos")) return trimmed;
  if (/youtube\.com\/@/i.test(trimmed)) return `${trimmed.replace(/\/$/, "")}/videos`;
  return trimmed;
}

function extractChannelIdFromUrl(url: string): string | null {
  const m = url.match(/\/channel\/(UC[\w-]+)/i);
  if (m?.[1]) return m[1];
  const u = safeUrl(url);
  if (!u) return null;
  const cid = u.searchParams.get("channel_id");
  return cid && cid.startsWith("UC") ? cid : null;
}

async function fetchChannelHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "StartupFeed/1.0 (YouTube resolver)",
      "Accept-Language": "en-US,en;q=0.9",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`YouTube HTML fetch failed (${response.status})`);
  return response.text();
}

function extractChannelIdFromHtml(html: string): string | null {
  const patterns = [
    /"externalId":"(UC[\w-]+)"/,
    /"channelId":"(UC[\w-]+)"/,
    /channel_id=(UC[\w-]+)/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

function extractVideoId(raw: Record<string, unknown>, link?: string): string | null {
  const rawVideoId = readString(raw["yt:videoId"]) || readString(raw.video_id);
  if (rawVideoId) return rawVideoId;
  if (!link) return null;
  const u = safeUrl(link);
  if (!u) return null;
  if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
  if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "") || null;
  return null;
}

function extractChannelId(raw: Record<string, unknown>): string | null {
  const fromRaw = readString(raw["yt:channelId"]) || readString(raw.channel_id);
  return fromRaw || null;
}

function extractThumbnail(raw: Record<string, unknown>): string | null {
  const fromRaw = readString(raw.thumbnail_url);
  if (fromRaw) return fromRaw;
  const urls = (JSON.stringify(raw).match(/https?:\/\/i\.ytimg\.com\/[^\s"']+/g) ?? []);
  return urls[0] ?? null;
}

function toStoredSummary(input: string): string {
  const normalized = normalizeSummaryText(input);
  return sanitizeSummaryForDisplay(normalized);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
