import Parser from 'rss-parser'
import type { RawItem } from './types'
import type { CrawlPolicy } from '@/lib/types'
import { isMeaningfulSummary, normalizeSummaryText, normalizeTitle, sanitizeSummaryForDisplay } from '@/lib/text'

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'StartupFeed/1.0 (RSS Reader)',
  },
})

export async function fetchRss(
  seedUrl: string,
  policy: CrawlPolicy,
): Promise<RawItem[]> {
  const feed = await fetchFeed(seedUrl)
  const maxItems = policy.max_items_per_run ?? 30

  return (feed.items ?? []).slice(0, maxItems).map((entry) => {
    // summary: contentSnippet (text) 우선, 없으면 content에서 HTML strip
    let summary = entry.contentSnippet ?? ''
    if (!summary && entry.content) {
      summary = entry.content.replace(/<[^>]*>/g, '').trim()
    }

    return {
      title: normalizeTitle(entry.title?.trim() ?? ''),
      canonical_url: entry.link ?? '',
      summary: toStoredSummary(summary),
      author: normalizeTitle(entry.creator ?? entry.author ?? ''),
      published_at: entry.isoDate ?? undefined,
      source_item_id: entry.guid ?? entry.link ?? undefined,
      raw: entry as unknown as Record<string, unknown>,
    }
  })
}

function toStoredSummary(input: string): string {
  const normalized = normalizeSummaryText(input)
  const cleaned = sanitizeSummaryForDisplay(normalized)
  return isMeaningfulSummary(cleaned) ? cleaned : ""
}

async function fetchFeed(seedUrl: string) {
  try {
    return await parser.parseURL(seedUrl)
  } catch (err) {
    const scraperApiKey = process.env.SCRAPER_API_KEY
    if (!scraperApiKey) throw err

    const proxyUrl = new URL('http://api.scraperapi.com')
    proxyUrl.searchParams.set('api_key', scraperApiKey)
    proxyUrl.searchParams.set('url', seedUrl)

    const response = await fetch(proxyUrl.toString(), {
      headers: {
        'User-Agent': 'StartupFeed/1.0 (RSS Reader)',
      },
      cache: 'no-store',
    })
    if (!response.ok) {
      throw new Error(`RSS fetch failed (${response.status}) via ScraperAPI`)
    }
    const xml = await response.text()
    return await parser.parseString(xml)
  }
}
