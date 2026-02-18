# Design: daily-crawl-viewer

> Plan 문서: [daily-crawl-viewer.plan.md](../../01-plan/features/daily-crawl-viewer.plan.md)

---

## 1. 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│  Scheduler (GitHub Actions cron UTC 16:00)                      │
│       │                                                         │
│       ▼                                                         │
│  POST /api/crawl ──────────────────────────────────────────┐    │
│       │                                                    │    │
│       ▼                                                    │    │
│  ┌──────────┐   ┌─────────────┐   ┌────────────────────┐  │    │
│  │ crawl_run│──▶│ Source Loop  │──▶│ Quality Filter     │  │    │
│  │ (start)  │   │ RSS / HTML  │   │ Pipeline (10-step) │  │    │
│  └──────────┘   └─────────────┘   └────────┬───────────┘  │    │
│                                             │              │    │
│                                     ┌───────▼──────┐      │    │
│                                     │ items upsert │      │    │
│                                     │ (hash dedup) │      │    │
│                                     └───────┬──────┘      │    │
│                                             │              │    │
│                                     ┌───────▼──────────┐   │    │
│                                     │ OpenAI Translate  │   │    │
│                                     │ (batch, budget)   │   │    │
│                                     └───────┬──────────┘   │    │
│                                             │              │    │
│                                     ┌───────▼──────┐      │    │
│                                     │ crawl_run    │      │    │
│                                     │ (finish)     │      │    │
│                                     └──────────────┘      │    │
│                                                            │    │
│  Supabase Postgres ◄───────────────────────────────────────┘    │
│       │                                                         │
│       ▼                                                         │
│  Next.js App Router (Viewer)                                    │
│  ┌──────┐ ┌───────────┐ ┌──────────┐ ┌────────┐               │
│  │  /   │ │ /item/[id] │ │ /sources │ │ /runs  │               │
│  └──────┘ └───────────┘ └──────────┘ └────────┘               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. DB 스키마 V3 — 완전 DDL

### 2.1 sources

```sql
create table public.sources (
  id            uuid default gen_random_uuid() primary key,
  name          text not null,
  type          text not null default 'rss'
                check (type in ('rss','html','api','youtube')),
  base_url      text,
  seed_url      text not null,
  is_active     boolean not null default true,
  priority      int not null default 50
                check (priority between 1 and 100),
  crawl_policy  jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index idx_sources_active_priority
  on public.sources (is_active, priority desc);
```

### 2.2 items

```sql
create table public.items (
  id              uuid default gen_random_uuid() primary key,
  source_id       uuid not null references public.sources(id) on delete cascade,
  source_item_id  text,
  canonical_url   text not null,
  title           text not null,
  summary         text,
  author          text,
  published_at    timestamptz,
  language        text not null default 'en',
  raw             jsonb not null default '{}'::jsonb,
  hash            text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index idx_items_hash
  on public.items (hash);
create index idx_items_source_published
  on public.items (source_id, published_at desc nulls last);
create index idx_items_published_at
  on public.items (published_at desc nulls last);
```

### 2.3 item_translations

```sql
create table public.item_translations (
  id                  uuid default gen_random_uuid() primary key,
  item_id             uuid not null references public.items(id) on delete cascade,
  lang                text not null default 'ko',
  title_translated    text,
  summary_translated  text,
  provider            text not null default 'openai',
  model               text not null default 'gpt-4o-mini',
  tokens_used         int,
  translated_at       timestamptz not null default now(),
  constraint uq_item_translation unique (item_id, lang)
);

create index idx_item_translations_item
  on public.item_translations (item_id);
```

### 2.4 crawl_runs

```sql
create table public.crawl_runs (
  id                  uuid default gen_random_uuid() primary key,
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  status              text not null default 'running'
                      check (status in ('running','success','partial_fail','fail')),
  total_sources       int not null default 0,
  items_found         int not null default 0,
  items_saved         int not null default 0,
  items_translated    int not null default 0,
  error_count         int not null default 0,
  translate_skipped   int not null default 0,
  translate_failed    int not null default 0
);

create index idx_crawl_runs_started
  on public.crawl_runs (started_at desc);
```

### 2.5 crawl_logs

```sql
create table public.crawl_logs (
  id          uuid default gen_random_uuid() primary key,
  run_id      uuid not null references public.crawl_runs(id) on delete cascade,
  source_id   uuid references public.sources(id) on delete set null,
  level       text not null default 'info'
              check (level in ('info','warn','error')),
  message     text not null,
  meta        jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index idx_crawl_logs_run
  on public.crawl_logs (run_id);
```

### 2.6 Trigger + RLS

```sql
-- updated_at auto-trigger
create or replace function public.set_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger trg_items_updated
  before update on public.items
  for each row execute function public.set_updated_at();

-- RLS: anon read, service_role write
alter table public.sources           enable row level security;
alter table public.items             enable row level security;
alter table public.item_translations enable row level security;
alter table public.crawl_runs        enable row level security;
alter table public.crawl_logs        enable row level security;

-- anon: SELECT only (viewer)
-- service_role: full access (crawler)
do $$
declare t text;
begin
  for t in select unnest(array[
    'sources','items','item_translations','crawl_runs','crawl_logs'
  ]) loop
    execute format(
      'create policy "anon_read_%1$s" on public.%1$s for select using (true)', t);
    execute format(
      'create policy "service_write_%1$s" on public.%1$s for all using (true) with check (true)', t);
  end loop;
end $$;
```

### 2.7 Seed 소스 (6건)

```sql
insert into public.sources (name, type, seed_url, base_url, priority, crawl_policy)
values
  ('YC Blog', 'rss',
   'https://www.ycombinator.com/blog/rss/',
   'https://www.ycombinator.com/blog',
   90,
   '{"fetch_mode":"list_only","max_items_per_run":30,"recency_days":7,
     "min_title_len":12,"min_summary_len":20,
     "block_keywords":["sponsored","advertisement","promo","jobs","hiring"],
     "translate_only_if":{"summary_char_limit":600,"title_char_limit":140},
     "translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),

  ('a16z Blog', 'rss',
   'https://a16z.com/feed/',
   'https://a16z.com',
   85,
   '{"fetch_mode":"list_only","max_items_per_run":30,"recency_days":7,
     "min_title_len":12,"min_summary_len":20,
     "block_keywords":["sponsored","advertisement","promo","newsletter"],
     "translate_only_if":{"summary_char_limit":600,"title_char_limit":140},
     "translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),

  ('TechCrunch Startups', 'rss',
   'https://techcrunch.com/category/startups/feed/',
   'https://techcrunch.com',
   80,
   '{"fetch_mode":"list_only","max_items_per_run":30,"recency_days":7,
     "min_title_len":12,"min_summary_len":40,
     "block_keywords":["sponsored","advertisement","promo","jobs","hiring","newsletter"],
     "translate_only_if":{"summary_char_limit":600,"title_char_limit":140},
     "translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),

  ('Hacker News Best', 'rss',
   'https://hnrss.org/best',
   'https://news.ycombinator.com',
   70,
   '{"fetch_mode":"list_only","max_items_per_run":30,"recency_days":3,
     "min_title_len":10,"min_summary_len":0,
     "block_keywords":["hiring","job","ask hn: who is hiring"],
     "translate_only_if":{"summary_char_limit":600,"title_char_limit":140},
     "translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),

  ('The Verge Tech', 'rss',
   'https://www.theverge.com/rss/tech/index.xml',
   'https://www.theverge.com',
   60,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":3,
     "min_title_len":12,"min_summary_len":30,
     "block_keywords":["sponsored","advertisement","deal","sale"],
     "translate_only_if":{"summary_char_limit":600,"title_char_limit":140},
     "translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),

  ('MIT Tech Review', 'rss',
   'https://www.technologyreview.com/feed/',
   'https://www.technologyreview.com',
   50,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":7,
     "min_title_len":12,"min_summary_len":40,
     "block_keywords":["sponsored","advertisement","promo","newsletter","podcast"],
     "translate_only_if":{"summary_char_limit":600,"title_char_limit":140},
     "translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb);
```

---

## 3. 크롤링 파이프라인 상세 설계

### 3.1 파일 구조 + 책임

```
lib/crawl/
├── index.ts            ← crawlDaily() 오케스트레이터
├── rss-fetcher.ts      ← RSS feed 파싱 (rss-parser)
├── html-fetcher.ts     ← HTML list 파싱 (cheerio) — stub
├── quality-filter.ts   ← 10단계 품질 필터
├── hasher.ts           ← sha256(canonical_url)
├── translator.ts       ← OpenAI 배치 번역 + budget guard
└── types.ts            ← 타입 정의
```

### 3.2 types.ts — 핵심 타입

```typescript
// 파싱된 raw 아이템 (소스에서 추출 직후)
export interface RawItem {
  title: string
  canonical_url: string
  summary?: string
  author?: string
  published_at?: string  // ISO 8601
  language?: string
  source_item_id?: string
  raw: Record<string, unknown>
}

// DB 저장용
export interface ItemInsert {
  source_id: string
  source_item_id?: string
  canonical_url: string
  title: string
  summary?: string
  author?: string
  published_at?: string
  language: string
  raw: Record<string, unknown>
  hash: string
}

// 품질 필터 결과
export interface FilterResult {
  passed: boolean
  reason?: string  // 스킵 사유
  field?: string
}

// 번역 요청 단위
export interface TranslationJob {
  item_id: string
  title: string
  summary: string
}

// 번역 결과
export interface TranslationResult {
  item_id: string
  title_translated: string
  summary_translated: string
  tokens_used: number
}

// crawl_policy 타입 (sources.crawl_policy jsonb)
export interface CrawlPolicy {
  fetch_mode?: 'list_only' | 'full'
  max_items_per_run?: number       // default 30
  rate_limit_per_min?: number      // default 30
  timeout_ms?: number              // default 15000
  recency_days?: number            // default 7
  min_title_len?: number           // default 12
  min_summary_len?: number         // default 40
  block_keywords?: string[]
  require_keywords_any?: string[]
  require_fields?: string[]        // default ["title","canonical_url"]
  include_url_regex?: string
  disallow_url_regex?: string
  dedupe_strategy?: 'url_hash'
  translate_only_if?: {
    summary_char_limit?: number    // default 600
    title_char_limit?: number      // default 140
  }
  translation_budget?: {
    max_tokens_per_run?: number    // default 20000
    max_tokens_per_item?: number   // default 400
    max_items_to_translate_per_run?: number  // default 50
  }
  translate_fail_policy?: {
    max_attempts?: number          // default 3
    keep_item_on_fail?: boolean    // default true
  }
}

// 크롤링 전체 통계
export interface CrawlStats {
  items_found: number
  items_saved: number
  items_translated: number
  error_count: number
  translate_skipped: number
  translate_failed: number
}
```

### 3.3 hasher.ts

```typescript
import { createHash } from 'crypto'

export function makeHash(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl).digest('hex')
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    u.searchParams.delete('utm_source')
    u.searchParams.delete('utm_medium')
    u.searchParams.delete('utm_campaign')
    u.searchParams.sort()
    return u.toString()
  } catch {
    return url
  }
}
```

### 3.4 rss-fetcher.ts

```typescript
import Parser from 'rss-parser'
import type { RawItem, CrawlPolicy } from './types'

const parser = new Parser({ timeout: 15000 })

export async function fetchRss(
  seedUrl: string,
  policy: CrawlPolicy
): Promise<RawItem[]> {
  const feed = await parser.parseURL(seedUrl)
  const maxItems = policy.max_items_per_run ?? 30

  return (feed.items ?? []).slice(0, maxItems).map(entry => ({
    title: entry.title ?? '',
    canonical_url: entry.link ?? '',
    summary: entry.contentSnippet ?? entry.content ?? '',
    author: entry.creator ?? entry.author ?? '',
    published_at: entry.isoDate ?? entry.pubDate ?? undefined,
    source_item_id: entry.guid ?? entry.link ?? undefined,
    raw: entry as Record<string, unknown>,
  }))
}
```

### 3.5 quality-filter.ts — 10단계 파이프라인

```typescript
import type { RawItem, CrawlPolicy, FilterResult } from './types'

const DEFAULTS: Partial<CrawlPolicy> = {
  recency_days: 7,
  min_title_len: 12,
  min_summary_len: 40,
  require_fields: ['title', 'canonical_url'],
  block_keywords: ['sponsored','advertisement','promo','jobs','hiring','newsletter'],
}

export function applyQualityFilter(
  item: RawItem,
  policy: CrawlPolicy
): FilterResult {
  const p = { ...DEFAULTS, ...policy }

  // Step 1: require_fields
  for (const field of (p.require_fields ?? [])) {
    const val = item[field as keyof RawItem]
    if (!val || (typeof val === 'string' && val.trim() === '')) {
      return { passed: false, reason: 'missing_required_field', field }
    }
  }

  // Step 2: recency_days
  if (p.recency_days && item.published_at) {
    const pub = new Date(item.published_at)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - p.recency_days)
    if (pub < cutoff) {
      return { passed: false, reason: 'too_old', field: 'published_at' }
    }
  }

  // Step 3: min_title_len
  if (p.min_title_len && item.title.length < p.min_title_len) {
    return { passed: false, reason: 'title_too_short', field: 'title' }
  }

  // Step 4: min_summary_len
  if (p.min_summary_len && (item.summary ?? '').length < p.min_summary_len) {
    return { passed: false, reason: 'summary_too_short', field: 'summary' }
  }

  // Step 5: block_keywords
  const text = `${item.title} ${item.summary ?? ''}`.toLowerCase()
  for (const kw of (p.block_keywords ?? [])) {
    if (text.includes(kw.toLowerCase())) {
      return { passed: false, reason: 'block_keyword', field: kw }
    }
  }

  // Step 6: require_keywords_any
  if (p.require_keywords_any && p.require_keywords_any.length > 0) {
    const found = p.require_keywords_any.some(kw =>
      text.includes(kw.toLowerCase())
    )
    if (!found) {
      return { passed: false, reason: 'no_required_keyword', field: 'require_keywords_any' }
    }
  }

  // Step 7: include_url_regex
  if (p.include_url_regex) {
    if (!new RegExp(p.include_url_regex).test(item.canonical_url)) {
      return { passed: false, reason: 'url_not_included', field: 'canonical_url' }
    }
  }

  // Step 8: disallow_url_regex
  if (p.disallow_url_regex) {
    if (new RegExp(p.disallow_url_regex).test(item.canonical_url)) {
      return { passed: false, reason: 'url_disallowed', field: 'canonical_url' }
    }
  }

  return { passed: true }
  // Step 9 (dedupe) + Step 10 (translation eligibility)는 orchestrator에서 처리
}
```

### 3.6 translator.ts — OpenAI 배치 번역 + Budget Guard

```typescript
import OpenAI from 'openai'
import type { TranslationJob, TranslationResult } from './types'

const SYSTEM_PROMPT = `You are a professional IT translator.
Translate the given titles and summaries into natural Korean.
Maintain technical terms (SaaS, IPO, AI, etc.) as-is.
Output ONLY the JSON array — no explanations.`

interface TranslateOptions {
  maxTokensPerRun: number     // default 20000
  maxTokensPerItem: number    // default 400
  batchSize: number           // default 10
  model: string               // default 'gpt-4o-mini'
}

const DEFAULT_OPTS: TranslateOptions = {
  maxTokensPerRun: 20000,
  maxTokensPerItem: 400,
  batchSize: 10,
  model: 'gpt-4o-mini',
}

export async function translateBatch(
  jobs: TranslationJob[],
  opts: Partial<TranslateOptions> = {}
): Promise<{
  results: TranslationResult[]
  totalTokens: number
  skipped: number
}> {
  const o = { ...DEFAULT_OPTS, ...opts }
  const openai = new OpenAI()  // OPENAI_API_KEY from env
  const results: TranslationResult[] = []
  let totalTokens = 0
  let skipped = 0

  // 배치 처리
  for (let i = 0; i < jobs.length; i += o.batchSize) {
    // Budget guard: 런 전체 상한 체크
    if (totalTokens >= o.maxTokensPerRun) {
      skipped += jobs.length - i
      break
    }

    const batch = jobs.slice(i, i + o.batchSize)

    const userContent = JSON.stringify(
      batch.map((j, idx) => ({
        idx,
        title: j.title.slice(0, 140),        // title_char_limit
        summary: (j.summary ?? '').slice(0, 600), // summary_char_limit
      }))
    )

    try {
      const resp = await openai.chat.completions.create({
        model: o.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Translate to Korean:\n${userContent}` },
        ],
        response_format: { type: 'json_object' },
        max_tokens: o.maxTokensPerItem * batch.length,
      })

      const usage = resp.usage?.total_tokens ?? 0
      totalTokens += usage

      const parsed = JSON.parse(resp.choices[0].message.content ?? '{}')
      const translations = parsed.translations ?? parsed.items ?? []

      for (let k = 0; k < batch.length; k++) {
        const t = translations[k]
        if (t) {
          results.push({
            item_id: batch[k].item_id,
            title_translated: t.title ?? '',
            summary_translated: t.summary ?? '',
            tokens_used: Math.round(usage / batch.length),
          })
        }
      }
    } catch (err) {
      // 번역 실패 시 해당 배치 스킵
      skipped += batch.length
      console.error(`Translation batch error:`, err)
    }
  }

  return { results, totalTokens, skipped }
}
```

### 3.7 index.ts — crawlDaily 오케스트레이터

```typescript
// 핵심 흐름 (pseudo-code)
export async function crawlDaily(req: CrawlRequest): Promise<CrawlSummary> {
  // 1. crawl_run 생성
  const run = await supabase.from('crawl_runs').insert({ status: 'running' }).select().single()

  // 2. active sources 로드 (priority DESC)
  const sources = await supabase.from('sources')
    .select('*')
    .eq('is_active', true)
    .order('priority', { ascending: false })

  // 3. 소스별 루프
  let stats: CrawlStats = { ... }
  let hasError = false

  for (const source of sources) {
    try {
      // 3a. 타입별 fetch
      const rawItems = source.type === 'rss'
        ? await fetchRss(source.seed_url, source.crawl_policy)
        : await fetchHtml(source.seed_url, source.crawl_policy)  // stub

      stats.items_found += rawItems.length

      // 3b. 품질 필터 + dedupe + upsert
      for (const raw of rawItems) {
        const normalized = normalizeUrl(raw.canonical_url)
        const hash = makeHash(normalized)

        // 필터
        const filter = applyQualityFilter(raw, source.crawl_policy)
        if (!filter.passed) {
          await logCrawl(run.id, source.id, 'info',
            `Skipped: ${filter.reason}`, { ...filter, title: raw.title })
          continue
        }

        // Dedupe check
        const existing = await supabase.from('items')
          .select('id').eq('hash', hash).maybeSingle()
        if (existing.data) {
          continue // 이미 존재
        }

        // Upsert
        if (!req.dryRun) {
          await supabase.from('items').upsert({
            source_id: source.id,
            title: raw.title,
            summary: raw.summary,
            author: raw.author,
            published_at: raw.published_at,
            canonical_url: normalized,
            language: raw.language ?? 'en',
            raw: raw.raw,
            hash,
          }, { onConflict: 'hash' })
          stats.items_saved++
        }
      }

      await logCrawl(run.id, source.id, 'info',
        `Source done: ${source.name}`, { items: rawItems.length })

    } catch (err) {
      hasError = true
      stats.error_count++
      await logCrawl(run.id, source.id, 'error', String(err))
    }
  }

  // 4. 번역 단계 (dryRun이 아니고 translate=true일 때)
  if (!req.dryRun && req.translate !== false) {
    // 번역 미존재 아이템 조회
    const untranslated = await supabase.from('items')
      .select('id, title, summary')
      .not('id', 'in',
        supabase.from('item_translations')
          .select('item_id').eq('lang', 'ko')
      )
      .limit(globalBudget.max_items_to_translate_per_run ?? 50)

    const jobs: TranslationJob[] = untranslated.map(i => ({
      item_id: i.id, title: i.title, summary: i.summary ?? ''
    }))

    const { results, totalTokens, skipped } = await translateBatch(jobs)

    // 번역 결과 저장
    for (const r of results) {
      await supabase.from('item_translations').upsert({
        item_id: r.item_id,
        lang: 'ko',
        title_translated: r.title_translated,
        summary_translated: r.summary_translated,
        provider: 'openai',
        model: 'gpt-4o-mini',
        tokens_used: r.tokens_used,
      }, { onConflict: 'item_id,lang' })
    }

    stats.items_translated = results.length
    stats.translate_skipped = skipped
  }

  // 5. crawl_run 종료
  const finalStatus = stats.error_count > 0
    ? (stats.items_saved > 0 ? 'partial_fail' : 'fail')
    : 'success'

  await supabase.from('crawl_runs').update({
    ended_at: new Date().toISOString(),
    status: finalStatus,
    total_sources: sources.length,
    ...stats,
  }).eq('id', run.id)

  return { runId: run.id, status: finalStatus, stats }
}
```

---

## 4. API 엔드포인트 설계

### 4.1 POST /api/crawl/route.ts

```typescript
// 인증: Authorization: Bearer <CRAWL_SECRET>
// Body: CrawlRequest (all optional)
//
// Response 200:
// {
//   runId: string,
//   status: 'success' | 'partial_fail' | 'fail',
//   stats: CrawlStats,
//   dryRun: boolean
// }
//
// Response 401: unauthorized
// Response 500: internal error
```

인증 방식: 환경변수 `CRAWL_SECRET`과 비교 (Bearer token)

### 4.2 환경변수

```
NEXT_PUBLIC_SUPABASE_URL=     # viewer에서 사용
NEXT_PUBLIC_SUPABASE_ANON_KEY= # viewer에서 사용 (SELECT only)
SUPABASE_SERVICE_ROLE_KEY=    # crawler에서 사용 (INSERT/UPDATE)
OPENAI_API_KEY=               # 번역
CRAWL_SECRET=                 # /api/crawl 인증
```

---

## 5. Next.js 뷰어 상세 설계

### 5.1 공통 레이아웃

```
┌──────────────────────────────────────────────┐
│  📡 StartupFeed    [홈] [소스] [크롤링 로그]  │
├──────────────────────────────────────────────┤
│                                              │
│  {children}                                  │
│                                              │
└──────────────────────────────────────────────┘
```

### 5.2 메인 페이지 (/) — Server Component

```
┌──────────────────────────────────────────────┐
│  필터 바                                      │
│  [소스 ▼] [기간: 24h | 7d | 30d] [🔍 검색]  │
├──────────────────────────────────────────────┤
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ 🏷️ YC Blog · 2h ago                   │  │
│  │ Congratulations to EquipmentShare...   │  │
│  │ EquipmentShare의 IPO를 축하합니다        │  │
│  │ 요약: 2015년 겨울, EquipmentShare...    │  │
│  │                        [원문 보기 →]   │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ 🏷️ TechCrunch · 5h ago                │  │
│  │ OpenAI launches new model...           │  │
│  │ OpenAI, 새로운 모델 출시...              │  │
│  │ 요약: OpenAI가 차세대 모델을...          │  │
│  │                        [원문 보기 →]   │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  [← 이전] 1 / 5 [다음 →]                    │
└──────────────────────────────────────────────┘
```

**Supabase 쿼리**:
```typescript
// 메인 리스트 (items + translations LEFT JOIN)
const { data } = await supabase
  .from('items')
  .select(`
    id, title, summary, author, published_at, canonical_url,
    sources!inner(name, type),
    item_translations(title_translated, summary_translated)
  `)
  .eq('item_translations.lang', 'ko')
  .order('published_at', { ascending: false })
  .range(offset, offset + pageSize - 1)

// 필터 적용
if (sourceId) query = query.eq('source_id', sourceId)
if (period === '24h') query = query.gte('published_at', dayAgo)
if (keyword) query = query.or(`title.ilike.%${keyword}%,summary.ilike.%${keyword}%`)
```

### 5.3 상세 페이지 (/item/[id])

```
┌──────────────────────────────────────────────┐
│  ← 뒤로                                      │
├──────────────────────────────────────────────┤
│                                              │
│  원문: Congratulations to EquipmentShare...  │
│  번역: EquipmentShare의 IPO를 축하합니다       │
│                                              │
│  원문 요약:                                    │
│  In winter 2015, when we first met...        │
│                                              │
│  번역 요약:                                    │
│  2015년 겨울, EquipmentShare 창업자들을...     │
│                                              │
│  ─────────────────────────────               │
│  소스: YC Blog · 저자: Garry Tan              │
│  게시일: 2026-01-16 · 번역: gpt-4o-mini      │
│  [원문 링크 →]                                │
│                                              │
└──────────────────────────────────────────────┘
```

### 5.4 소스 페이지 (/sources)

| name | type | priority | active | max_items | recency | block_keywords |
|------|------|----------|--------|-----------|---------|----------------|
| YC Blog | rss | 90 | ✅ | 30 | 7d | 5개 |
| a16z | rss | 85 | ✅ | 30 | 7d | 4개 |
| ... | ... | ... | ... | ... | ... | ... |

### 5.5 크롤링 런 페이지 (/runs)

```
┌──────────────────────────────────────────────┐
│  최근 크롤링 실행                              │
├──────────────────────────────────────────────┤
│  ✅ 2026-02-17 01:00 | success               │
│     소스: 6 | 발견: 42 | 저장: 38 | 번역: 35 │
│     [로그 보기 ▼]                             │
│     ├ [info] YC Blog: 8 items fetched        │
│     ├ [info] Skipped: too_old (3건)          │
│     ├ [warn] a16z: timeout after 15s         │
│     └ [error] MIT: 403 blocked               │
│                                              │
│  ⚠️ 2026-02-16 01:00 | partial_fail          │
│     ...                                      │
└──────────────────────────────────────────────┘
```

---

## 6. 스케줄링 상세

### 6.1 GitHub Actions (Primary)

```yaml
name: Daily Crawl
on:
  schedule:
    - cron: '0 16 * * *'   # UTC 16:00 = KST 01:00
  workflow_dispatch:
    inputs:
      dryRun:
        type: boolean
        default: false
      sources:
        type: string
        default: ''
jobs:
  crawl:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Trigger crawl
        run: |
          curl -sf -X POST "$CRAWL_ENDPOINT/api/crawl" \
            -H "Authorization: Bearer $CRAWL_SECRET" \
            -H "Content-Type: application/json" \
            -d "{\"dryRun\": ${{ inputs.dryRun || false }}, \"translate\": true}" \
            | jq .
        env:
          CRAWL_ENDPOINT: ${{ secrets.CRAWL_ENDPOINT }}
          CRAWL_SECRET: ${{ secrets.CRAWL_SECRET }}
```

### 6.2 Supabase pg_cron (Secondary)

```sql
-- pg_cron + pg_net 확장 필요
select cron.schedule('daily-crawl', '0 16 * * *', $$
  select net.http_post(
    url := current_setting('app.crawl_endpoint') || '/api/crawl',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.crawl_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{"translate":true}'::jsonb
  );
$$);
```

---

## 7. 구현 파일 매핑

| 순서 | 파일 | 역할 | 의존 |
|------|------|------|------|
| 1 | `supabase/schema.sql` | V3 DDL + seed | — |
| 2 | `lib/supabase.ts` | 클라이언트 (server/browser) | env |
| 3 | `lib/types.ts` | DB + 공통 타입 | — |
| 4 | `lib/crawl/types.ts` | 크롤링 타입 | — |
| 5 | `lib/crawl/hasher.ts` | URL hash | — |
| 6 | `lib/crawl/rss-fetcher.ts` | RSS 파싱 | rss-parser |
| 7 | `lib/crawl/html-fetcher.ts` | HTML 파싱 (stub) | cheerio |
| 8 | `lib/crawl/quality-filter.ts` | 품질 필터 | types |
| 9 | `lib/crawl/translator.ts` | 번역 + budget | openai |
| 10 | `lib/crawl/index.ts` | 오케스트레이터 | 5~9 |
| 11 | `app/api/crawl/route.ts` | POST endpoint | 10 |
| 12 | `app/layout.tsx` | 공통 레이아웃 | — |
| 13 | `app/page.tsx` | 메인 리스트 | 2,3 |
| 14 | `app/item/[id]/page.tsx` | 상세 | 2,3 |
| 15 | `app/sources/page.tsx` | 소스 목록 | 2,3 |
| 16 | `app/runs/page.tsx` | 런 로그 | 2,3 |
| 17 | `.github/workflows/daily-crawl.yml` | cron | 11 |

## 8. 패키지 의존성

```json
{
  "dependencies": {
    "next": "^14.2",
    "@supabase/supabase-js": "^2.45",
    "openai": "^4.70",
    "rss-parser": "^3.13",
    "cheerio": "^1.0"
  },
  "devDependencies": {
    "typescript": "^5.5",
    "@types/node": "^20",
    "tailwindcss": "^3.4",
    "autoprefixer": "^10",
    "postcss": "^8"
  }
}
```
