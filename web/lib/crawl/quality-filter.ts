import type { RawItem, FilterResult } from './types'
import type { CrawlPolicy } from '@/lib/types'

const DEFAULTS: Partial<CrawlPolicy> = {
  recency_days: 7,
  min_title_len: 12,
  min_summary_len: 40,
  require_fields: ['title', 'canonical_url'],
  block_keywords: [
    'sponsored', 'advertisement', 'promo', 'jobs', 'hiring', 'newsletter',
  ],
}

export function applyQualityFilter(
  item: RawItem,
  policy: CrawlPolicy,
): FilterResult {
  const p = { ...DEFAULTS, ...policy }

  // 1. require_fields
  for (const field of p.require_fields ?? []) {
    const val = item[field as keyof RawItem]
    if (!val || (typeof val === 'string' && val.trim() === '')) {
      return { passed: false, reason: 'missing_required_field', field }
    }
  }

  // 2. recency_days
  if (p.recency_days && item.published_at) {
    const pub = new Date(item.published_at)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - p.recency_days)
    if (pub < cutoff) {
      return { passed: false, reason: 'too_old', field: 'published_at' }
    }
  }

  // 3. min_title_len
  if (p.min_title_len && item.title.length < p.min_title_len) {
    return { passed: false, reason: 'title_too_short', field: 'title' }
  }

  // 4. min_summary_len
  if (p.min_summary_len && (item.summary ?? '').length < p.min_summary_len) {
    return { passed: false, reason: 'summary_too_short', field: 'summary' }
  }

  // 5. block_keywords
  const text = `${item.title} ${item.summary ?? ''}`.toLowerCase()
  for (const kw of p.block_keywords ?? []) {
    if (text.includes(kw.toLowerCase())) {
      return { passed: false, reason: 'block_keyword', field: kw }
    }
  }

  // 6. require_keywords_any
  if (p.require_keywords_any && p.require_keywords_any.length > 0) {
    const found = p.require_keywords_any.some((kw) =>
      text.includes(kw.toLowerCase()),
    )
    if (!found) {
      return { passed: false, reason: 'no_required_keyword', field: 'require_keywords_any' }
    }
  }

  // 7. include_url_regex
  if (p.include_url_regex) {
    if (!new RegExp(p.include_url_regex).test(item.canonical_url)) {
      return { passed: false, reason: 'url_not_included', field: 'canonical_url' }
    }
  }

  // 8. disallow_url_regex
  if (p.disallow_url_regex) {
    if (new RegExp(p.disallow_url_regex).test(item.canonical_url)) {
      return { passed: false, reason: 'url_disallowed', field: 'canonical_url' }
    }
  }

  return { passed: true }
}
