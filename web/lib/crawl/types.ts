export interface RawItem {
  title: string
  canonical_url: string
  summary?: string
  author?: string
  published_at?: string
  language?: string
  source_item_id?: string
  raw: Record<string, unknown>
}

export interface FilterResult {
  passed: boolean
  reason?: string
  field?: string
}

export interface TranslationJob {
  item_id: string
  title: string
  summary: string
}

export interface TranslationResult {
  item_id: string
  title_translated: string
  summary_translated: string
  tokens_used: number
}

export interface CrawlStats {
  items_found: number
  items_saved: number
  items_translated: number
  error_count: number
  translate_skipped: number
  translate_failed: number
}

export interface CrawlRequest {
  dryRun?: boolean
  sources?: string[]
  maxItemsOverride?: number
  translate?: boolean
}

export interface CrawlSummary {
  runId: string
  status: string
  stats: CrawlStats
  dryRun: boolean
}
