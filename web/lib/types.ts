// ── DB Row Types ────────────────────────────────────────────

export interface Source {
  id: string
  name: string
  type: 'rss' | 'html' | 'api' | 'youtube'
  base_url: string | null
  seed_url: string
  is_active: boolean
  priority: number
  crawl_policy: CrawlPolicy
  created_at: string
}

export interface Item {
  id: string
  source_id: string
  source_item_id: string | null
  canonical_url: string
  title: string
  summary: string | null
  author: string | null
  published_at: string | null
  language: string
  raw: Record<string, unknown>
  hash: string
  created_at: string
  updated_at: string
}

export interface ItemTranslation {
  id: string
  item_id: string
  lang: string
  title_translated: string | null
  summary_translated: string | null
  provider: string
  model: string
  tokens_used: number | null
  translated_at: string
}

export interface CrawlRun {
  id: string
  started_at: string
  ended_at: string | null
  status: 'running' | 'success' | 'partial_fail' | 'fail'
  total_sources: number
  items_found: number
  items_saved: number
  items_translated: number
  error_count: number
  translate_skipped: number
  translate_failed: number
}

export interface CrawlLog {
  id: string
  run_id: string
  source_id: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  meta: Record<string, unknown>
  created_at: string
}

// ── Viewer Joined Types ─────────────────────────────────────

export interface ItemWithTranslation extends Item {
  sources: Pick<Source, 'name' | 'type'>
  item_translations: Pick<ItemTranslation, 'title_translated' | 'summary_translated'>[]
}

// ── crawl_policy ────────────────────────────────────────────

export interface CrawlPolicy {
  fetch_mode?: 'list_only' | 'full'
  max_items_per_run?: number
  rate_limit_per_min?: number
  timeout_ms?: number
  recency_days?: number
  min_title_len?: number
  min_summary_len?: number
  block_keywords?: string[]
  require_keywords_any?: string[]
  require_fields?: string[]
  include_url_regex?: string
  disallow_url_regex?: string
  dedupe_strategy?: 'url_hash'
  translate_only_if?: {
    summary_char_limit?: number
    title_char_limit?: number
  }
  translation_budget?: {
    max_tokens_per_run?: number
    max_tokens_per_item?: number
    max_items_to_translate_per_run?: number
  }
  translate_fail_policy?: {
    max_attempts?: number
    keep_item_on_fail?: boolean
  }
}
