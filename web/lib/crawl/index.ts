import { createServerClient } from '@/lib/supabase'
import type { Source } from '@/lib/types'
import type { CrawlRequest, CrawlStats, CrawlSummary, TranslationJob } from './types'
import { fetchRss } from './rss-fetcher'
import { fetchYoutube } from './youtube-fetcher'
import { applyQualityFilter } from './quality-filter'
import { makeHash, normalizeUrl } from './hasher'
import { translateBatch } from './translator'
import { isMeaningfulSummary, normalizeSummaryText, normalizeTitle, sanitizeSummaryForDisplay } from '@/lib/text'

async function logCrawl(
  supabase: ReturnType<typeof createServerClient>,
  runId: string,
  sourceId: string | null,
  level: 'info' | 'warn' | 'error',
  message: string,
  meta: Record<string, unknown> = {},
) {
  await supabase.from('crawl_logs').insert({
    run_id: runId,
    source_id: sourceId,
    level,
    message,
    meta,
  })
}

export async function crawlDaily(req: CrawlRequest = {}): Promise<CrawlSummary> {
  const supabase = createServerClient()
  const dryRun = req.dryRun ?? false

  // 1. Start crawl_run
  const { data: run } = await supabase
    .from('crawl_runs')
    .insert({ status: 'running' })
    .select('id')
    .single()

  if (!run) throw new Error('Failed to create crawl_run')
  const runId = run.id

  // 2. Load active sources
  let query = supabase
    .from('sources')
    .select('*')
    .eq('is_active', true)
    .order('priority', { ascending: false })

  if (req.sources && req.sources.length > 0) {
    query = query.in('name', req.sources)
  }

  const { data: sources } = await query
  if (!sources || sources.length === 0) {
    await supabase.from('crawl_runs').update({
      ended_at: new Date().toISOString(),
      status: 'fail',
      total_sources: 0,
    }).eq('id', runId)
    return { runId, status: 'fail', stats: emptyStats(), dryRun }
  }

  const stats: CrawlStats = emptyStats()

  // 3. Source loop
  for (const source of sources as Source[]) {
    try {
      await logCrawl(supabase, runId, source.id, 'info', `Start: ${source.name}`)

      // 3a. Fetch by type
      let rawItems
      if (source.type === 'rss') {
        rawItems = await fetchRss(source.seed_url, source.crawl_policy)
      } else if (source.type === 'youtube') {
        rawItems = await fetchYoutube(source.seed_url, source.crawl_policy)
      } else {
        // html/api/youtube — stub for now
        await logCrawl(supabase, runId, source.id, 'warn',
          `Unsupported type: ${source.type}, skipping`)
        continue
      }

      stats.items_found += rawItems.length

      let savedInSource = 0
      let skippedInSource = 0

      // 3b. Quality filter + dedupe + upsert
      for (const raw of rawItems) {
        const normalized = normalizeUrl(raw.canonical_url)
        const hash = makeHash(normalized)
        const cleanTitle = normalizeTitle(raw.title)
        const cleanSummary = sanitizeSummaryForDisplay(normalizeSummaryText(raw.summary))
        const cleanAuthor = normalizeTitle(raw.author)
        const storedSummary = isMeaningfulSummary(cleanSummary) ? cleanSummary : ""

        // Quality filter
        const filter = applyQualityFilter(
          { ...raw, title: cleanTitle, summary: storedSummary },
          source.crawl_policy,
        )
        if (!filter.passed) {
          await logCrawl(supabase, runId, source.id, 'info',
            `Skipped: ${filter.reason}`,
            { reason: filter.reason, field: filter.field, title: cleanTitle.slice(0, 80) })
          skippedInSource++
          continue
        }

        // Dedupe
        const { data: existing } = await supabase
          .from('items')
          .select('id')
          .eq('hash', hash)
          .maybeSingle()

        if (existing) {
          skippedInSource++
          continue
        }

        // Upsert
        if (!dryRun) {
          await supabase.from('items').upsert({
            source_id: source.id,
            source_item_id: raw.source_item_id ?? null,
            canonical_url: normalized,
            title: cleanTitle,
            summary: storedSummary || null,
            author: cleanAuthor || null,
            published_at: raw.published_at ?? null,
            language: raw.language ?? 'en',
            raw: raw.raw,
            hash,
          }, { onConflict: 'hash' })
          savedInSource++
        }
      }

      stats.items_saved += savedInSource
      await logCrawl(supabase, runId, source.id, 'info',
        `Done: ${source.name} — saved=${savedInSource} skipped=${skippedInSource}`,
        { saved: savedInSource, skipped: skippedInSource, found: rawItems.length })

    } catch (err) {
      stats.error_count++
      const message = err instanceof Error ? err.message : String(err)

      // Detect 403/blocked
      const isBlocked = message.includes('403') || message.includes('captcha')
      await logCrawl(supabase, runId, source.id, 'error', message,
        isBlocked ? { blocked: true } : {})
    }
  }

  // 4. Translation phase
  if (!dryRun && req.translate !== false) {
    try {
      const maxTranslate = 80
      const { jobs, scanned } = await collectPendingTranslationJobs(supabase, {
        maxJobs: maxTranslate,
        batchSize: 200,
        maxScanRows: 5000,
      })

      if (jobs.length > 0) {
        const { results, totalTokens, skipped, failed } = await translateBatch(jobs, {
          maxTokensPerRun: 20000,
          model: 'gemini-2.0-flash',
        })

        // Save translations
        for (const r of results) {
          await supabase.from('item_translations').upsert({
            item_id: r.item_id,
            lang: 'ko',
            title_translated: r.title_translated,
            summary_translated: r.summary_translated,
            provider: 'gemini',
            model: 'gemini-2.0-flash',
            tokens_used: r.tokens_used,
          }, { onConflict: 'item_id,lang' })
        }

        stats.items_translated = results.length
        stats.translate_skipped = skipped
        stats.translate_failed = failed

        await logCrawl(supabase, runId, null, 'info',
          `Translation done: translated=${results.length} skipped=${skipped} failed=${failed} scanned=${scanned} jobs=${jobs.length} tokens=${totalTokens}`,
          { totalTokens, translated: results.length, skipped, failed, scanned, jobs: jobs.length })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await logCrawl(supabase, runId, null, 'error', `Translation error: ${message}`)
      stats.translate_failed++
    }
  }

  // 5. Finalize crawl_run
  const finalStatus = stats.error_count > 0
    ? (stats.items_saved > 0 ? 'partial_fail' : 'fail')
    : 'success'

  await supabase.from('crawl_runs').update({
    ended_at: new Date().toISOString(),
    status: finalStatus,
    total_sources: (sources as Source[]).length,
    ...stats,
  }).eq('id', runId)

  return { runId, status: finalStatus, stats, dryRun }
}

function hasTranslatedText(value: string | null | undefined): boolean {
  return Boolean(value && value.trim())
}

async function collectPendingTranslationJobs(
  supabase: ReturnType<typeof createServerClient>,
  opts: { maxJobs: number; batchSize: number; maxScanRows: number },
): Promise<{ jobs: TranslationJob[]; scanned: number }> {
  const jobs: TranslationJob[] = []
  let scanned = 0
  let offset = 0

  while (jobs.length < opts.maxJobs && scanned < opts.maxScanRows) {
    const { data: items, error: itemsError } = await supabase
      .from('items')
      .select('id, title, summary')
      .order('created_at', { ascending: true })
      .range(offset, offset + opts.batchSize - 1)

    if (itemsError) throw itemsError
    if (!items || items.length === 0) break

    scanned += items.length
    offset += items.length

    const itemIds = items.map((item) => item.id)
    const { data: translations, error: trError } = await supabase
      .from('item_translations')
      .select('item_id, title_translated, summary_translated')
      .eq('lang', 'ko')
      .in('item_id', itemIds)

    if (trError) throw trError

    const trByItemId = new Map(
      (translations ?? []).map((tr) => [tr.item_id, tr]),
    )

    for (const item of items) {
      const tr = trByItemId.get(item.id)
      const isTranslated = hasTranslatedText(tr?.title_translated) || hasTranslatedText(tr?.summary_translated)
      if (isTranslated) continue

      jobs.push({
        item_id: item.id,
        title: item.title,
        summary: item.summary ?? '',
      })

      if (jobs.length >= opts.maxJobs) break
    }
  }

  return { jobs, scanned }
}

function emptyStats(): CrawlStats {
  return {
    items_found: 0,
    items_saved: 0,
    items_translated: 0,
    error_count: 0,
    translate_skipped: 0,
    translate_failed: 0,
  }
}
