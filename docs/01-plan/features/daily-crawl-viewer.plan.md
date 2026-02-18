# Plan: daily-crawl-viewer

> 매일 01:00 KST에 다중 소스를 list_only 크롤링하여 한글 번역 후 저장하고, 웹 뷰어로 조회하는 시스템

## 1. Overview

| 항목 | 내용 |
|------|------|
| Feature | daily-crawl-viewer |
| Level | Dynamic |
| Priority | P0 (핵심 기능) |
| Scope | DB 스키마 리셋 + 크롤러(TS) + 스케줄러 + Next.js 뷰어 |
| Out of Scope | 큐레이션 리포트, 알림, full_content 크롤링 |

### 현재 상태 vs 목표

| 항목 | 현재 (V2 Python) | 목표 (V3 TypeScript) |
|------|-------------------|----------------------|
| 언어 | Python | TypeScript |
| 크롤링 | full content 포함 | list_only (title/summary/link) |
| 번역 | Gemini API | OpenAI API (provider 교체 가능) |
| 품질 필터 | 없음 | crawl_policy 기반 가드레일 |
| 번역 비용 제어 | 없음 | token budget + char limit + batch |
| 스케줄 | 수동 실행 | 매일 01:00 KST 자동 |
| 뷰어 | 없음 | Next.js App Router |
| DB 스키마 | V2 (9 테이블) | V3 (5 핵심 테이블, 간결화) |
| crawl_runs | source별 1건 | run 전체 1건 (다중 소스 통합) |

## 2. 기술 스택

| 레이어 | 기술 | 비고 |
|--------|------|------|
| DB | Supabase (Postgres 15+) | RLS, Edge Functions |
| 크롤러 | TypeScript + rss-parser + cheerio | Supabase Edge Function 또는 standalone |
| 번역 | OpenAI API (gpt-4o-mini) | provider/model 교체 가능 설계 |
| 스케줄 | GitHub Actions cron (primary) + Supabase trigger (secondary) | UTC 16:00 = KST 01:00 |
| 뷰어 | Next.js 14+ App Router + TypeScript | Supabase JS client 직접 연결 |
| 배포 | Vercel (뷰어) | Edge Function은 Supabase 내장 |

## 3. DB 스키마 설계 (V3)

### 3.1 기존 V2 대비 변경사항

| 변경 | 이유 |
|------|------|
| entities, item_entities, tags, item_tags 제거 | 이번 스코프에서 불필요 (추후 확장 포인트) |
| sources에 `seed_url`, `priority` 추가 | list_only 크롤링에 필수 |
| sources.type에 `youtube` 추가 | 향후 확장 |
| items에서 content_text/content_html 제거 | list_only 기본, 추후 nullable로 복원 가능 |
| item_translations 컬럼명 변경 | title→title_translated, summary→summary_translated, provider/model/tokens_used 추가 |
| crawl_runs를 run 전체 단위로 변경 | source_id FK 제거, total_sources/translate 통계 추가 |
| crawl_logs에 level(info/warn/error) + meta(jsonb) 추가 | 품질 필터 스킵 사유 기록 |

### 3.2 테이블 정의

#### A) sources
```
id              uuid PK default gen_random_uuid()
name            text NOT NULL
type            text NOT NULL CHECK (rss|html|api|youtube)
base_url        text                    -- 소스 홈페이지
seed_url        text                    -- 실제 크롤링 대상 URL (RSS URL 또는 list page)
is_active       boolean NOT NULL DEFAULT true
priority        int NOT NULL DEFAULT 50  -- 높을수록 먼저 처리 (1~100)
crawl_policy    jsonb NOT NULL DEFAULT '{}'
created_at      timestamptz NOT NULL DEFAULT now()
```

인덱스: `(is_active, priority DESC)`

#### B) items
```
id              uuid PK default gen_random_uuid()
source_id       uuid FK → sources(id) ON DELETE CASCADE
source_item_id  text                    -- 소스 내 고유 ID
canonical_url   text NOT NULL
title           text NOT NULL
summary         text
author          text
published_at    timestamptz
language        text NOT NULL DEFAULT 'en'
raw             jsonb NOT NULL DEFAULT '{}'
hash            text NOT NULL           -- sha256(canonical_url)
created_at      timestamptz NOT NULL DEFAULT now()
updated_at      timestamptz NOT NULL DEFAULT now()
```

인덱스:
- `UNIQUE (hash)`
- `(source_id, published_at DESC)`
- `(published_at DESC)`

확장 포인트 (이번에는 미생성):
- `content_text text` — full_content 크롤링 시 추가
- `content_html text` — full_content 크롤링 시 추가

#### C) item_translations
```
id                  uuid PK default gen_random_uuid()
item_id             uuid FK → items(id) ON DELETE CASCADE
lang                text NOT NULL DEFAULT 'ko'
title_translated    text
summary_translated  text
provider            text                -- 'openai', 'gemini' 등
model               text                -- 'gpt-4o-mini' 등
tokens_used         int                 -- nullable, 비용 추적
translated_at       timestamptz NOT NULL DEFAULT now()
```

제약: `UNIQUE (item_id, lang)`
인덱스: `(item_id)`

#### D) crawl_runs
```
id                  uuid PK default gen_random_uuid()
started_at          timestamptz NOT NULL DEFAULT now()
ended_at            timestamptz
status              text NOT NULL DEFAULT 'running'
                    CHECK (running|success|partial_fail|fail)
total_sources       int NOT NULL DEFAULT 0
items_found         int NOT NULL DEFAULT 0
items_saved         int NOT NULL DEFAULT 0
items_translated    int NOT NULL DEFAULT 0
error_count         int NOT NULL DEFAULT 0
translate_skipped   int NOT NULL DEFAULT 0
translate_failed    int NOT NULL DEFAULT 0
```

인덱스: `(started_at DESC)`

#### E) crawl_logs
```
id              uuid PK default gen_random_uuid()
run_id          uuid FK → crawl_runs(id) ON DELETE CASCADE
source_id       uuid FK → sources(id) ON DELETE SET NULL (nullable)
level           text NOT NULL DEFAULT 'info'
                CHECK (info|warn|error)
message         text NOT NULL
meta            jsonb DEFAULT '{}'      -- 스킵 사유, 에러 상세 등
created_at      timestamptz NOT NULL DEFAULT now()
```

인덱스: `(run_id)`

### 3.3 기존 데이터 처리

- 기존 V2 테이블(sources, items, item_translations 등)은 **DROP → 재생성**
- 기존 3건 데이터는 seed SQL에서 재삽입 또는 마이그레이션 스크립트로 이전
- 기존 yc_articles 테이블은 이미 백업 대상

## 4. crawl_policy 설계 (품질 필터 + 가드레일)

### 4.1 전체 구조 (sources.crawl_policy jsonb)

```jsonc
{
  // ── 수집 범위/부하 ──
  "fetch_mode": "list_only",
  "max_items_per_run": 30,
  "rate_limit_per_min": 30,
  "timeout_ms": 15000,
  "allow_domains": [],
  "include_url_regex": null,
  "disallow_url_regex": null,
  "recency_days": 7,

  // ── 품질 필터 (저장/번역 전) ──
  "min_title_len": 12,
  "min_summary_len": 40,
  "block_keywords": ["sponsored","advertisement","promo","jobs","hiring","newsletter"],
  "require_keywords_any": [],
  "require_fields": ["title","canonical_url"],
  "dedupe_strategy": "url_hash",

  // ── 번역 비용 가드레일 ──
  "translate_only_if": {
    "summary_char_limit": 600,
    "title_char_limit": 140
  },
  "translation_budget": {
    "max_tokens_per_run": 20000,
    "max_tokens_per_item": 400,
    "max_items_to_translate_per_run": 50
  },
  "translation_batching": {
    "batch_size": 10
  },
  "translate_fail_policy": {
    "max_attempts": 3,
    "keep_item_on_fail": true
  }
}
```

### 4.2 필터 적용 순서 (파이프라인)

```
RSS/HTML 파싱
  → 1. require_fields 체크 (title, canonical_url 필수)
  → 2. recency_days 체크 (7일 이내)
  → 3. min_title_len / min_summary_len 체크
  → 4. block_keywords 체크 (제목+요약에 포함 시 스킵)
  → 5. require_keywords_any 체크 (설정 시, 하나도 없으면 스킵)
  → 6. include_url_regex / disallow_url_regex 체크
  → 7. hash 기반 dedupe (기존 items 확인)
  ✅ 통과 → items INSERT
  → 8. 번역 대상 확인 (language != 'ko' AND translation 미존재)
  → 9. char_limit 적용 (title 140자, summary 600자 truncate)
  → 10. token budget 확인 (초과 시 스킵 + 로그)
  ✅ 통과 → item_translations INSERT
```

스킵된 아이템은 `crawl_logs.meta`에 사유를 기록:
```json
{"skipped_reason": "block_keyword", "keyword": "sponsored", "field": "title"}
```

## 5. 크롤링 엔드포인트 설계

### 5.1 POST /api/crawl (또는 Edge Function)

**입력** (모두 optional):
```typescript
interface CrawlRequest {
  dryRun?: boolean        // true면 저장/번역 없이 파싱 결과만 반환
  sources?: string[]      // source slug 배열 (비어있으면 전체 active)
  maxItemsOverride?: number
  translate?: boolean     // default true
}
```

**처리 흐름**:
```
1. crawl_runs 생성 (status=running)
2. sources 로드 (is_active=true, priority DESC)
3. 소스별 루프:
   a. type='rss' → rss-parser로 feed 파싱
   b. type='html' → fetch + cheerio로 list 추출
   c. 아이템별:
      - canonical_url 정규화 + sha256 hash
      - 품질 필터 파이프라인 (§4.2)
      - items upsert (ON CONFLICT hash DO UPDATE)
   d. crawl_logs 기록 (source 단위 요약)
4. 번역 단계 (items 저장 완료 후):
   - item_translations 미존재 건만 수집
   - char_limit 적용 + 배치(10건) + OpenAI API 호출
   - token budget 초과 시 남은 건 스킵
   - 실패 시 item은 유지, 로그에 기록
5. crawl_runs 종료 업데이트 (status, counts)
6. 결과 반환 (JSON summary)
```

**에러 처리**:
- 소스별 try-catch: 실패해도 다른 소스는 계속 진행
- 403/캡차 감지: `crawl_logs.meta = {blocked: true, status_code: 403}`
- 전체 실패 시 status='fail', 일부 실패 시 status='partial_fail'

### 5.2 번역 파이프라인 상세

```typescript
// pseudo
for each batch of untranslated items (batch_size=10):
  if totalTokensUsed >= max_tokens_per_run:
    log "budget exhausted", skip remaining
    break

  prompt = buildBatchPrompt(batch)  // title + summary 다건 묶어서
  response = openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: TRANSLATOR_PROMPT }, ...]
  })

  for each translation in response:
    INSERT INTO item_translations (item_id, lang, title_translated, summary_translated, provider, model, tokens_used)
    totalTokensUsed += usage.total_tokens
```

## 6. 스케줄링 설계

### 6.1 Option A: GitHub Actions Cron (Primary — 권장)

```yaml
# .github/workflows/daily-crawl.yml
name: Daily Crawl
on:
  schedule:
    - cron: '0 16 * * *'  # UTC 16:00 = KST 01:00
  workflow_dispatch:        # 수동 실행
jobs:
  crawl:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -X POST "${{ secrets.CRAWL_ENDPOINT }}" \
            -H "Authorization: Bearer ${{ secrets.CRAWL_SECRET }}" \
            -H "Content-Type: application/json" \
            -d '{"translate": true}'
```

장점: 무료, 로그 확인 쉬움, 수동 재실행 가능
단점: 최대 5~15분 지연 가능

### 6.2 Option B: Supabase pg_cron

```sql
select cron.schedule(
  'daily-crawl',
  '0 16 * * *',  -- UTC 16:00
  $$
  select net.http_post(
    url := 'https://<project>.supabase.co/functions/v1/crawl-daily',
    headers := '{"Authorization": "Bearer <service_role_key>"}'::jsonb,
    body := '{"translate": true}'::jsonb
  );
  $$
);
```

장점: Supabase 내부 통합, 지연 없음
단점: pg_net 확장 필요, 디버깅 어려움

## 7. Next.js 뷰어 설계

### 7.1 페이지 구조

```
app/
├── layout.tsx              -- 글로벌 레이아웃 (헤더, 네비게이션)
├── page.tsx                -- / : 최신 아이템 리스트
├── item/[id]/page.tsx      -- /item/[id] : 아이템 상세
├── sources/page.tsx        -- /sources : 소스 목록
├── runs/page.tsx           -- /runs : 크롤링 런 로그
└── api/
    └── crawl/route.ts      -- POST /api/crawl : 크롤링 엔드포인트
```

### 7.2 메인 페이지 (/)

| 요소 | 설명 |
|------|------|
| 카드 리스트 | title(원문) + title_ko + summary_ko + source badge + published_at + 외부 링크 |
| 필터 바 | 소스 드롭다운 / 기간(24h, 7d, 30d) / 키워드 검색(title, summary_ko) |
| 정렬 | 최신순 (published_at DESC) |
| 페이지네이션 | cursor-based (published_at + id) |
| 번역 대기 | title_ko가 없으면 "번역 대기" 뱃지 표시 |

### 7.3 상세 페이지 (/item/[id])

- 원문 title + 번역 title_ko
- 원문 summary + 번역 summary_ko
- author, published_at, source 정보
- canonical_url → 원문 링크
- raw (jsonb) 일부 표시 (디버깅/참고용)

### 7.4 소스 관리 (/sources)

- 소스 목록 테이블: name, type, is_active, priority, seed_url
- crawl_policy 요약 (max_items, recency_days, block_keywords 개수)
- 최근 크롤링 시간 표시

### 7.5 크롤링 런 (/runs)

- 최근 crawl_runs 리스트: started_at, status, items_found/saved/translated
- 클릭 시 해당 run의 crawl_logs 표시 (level별 색상 구분)

## 8. 초기 Seed 소스

RSS 기반 4~6개 (봇 차단 없는 안정적 소스):

| # | name | type | seed_url | priority |
|---|------|------|----------|----------|
| 1 | YC Blog | rss | https://www.ycombinator.com/blog/rss/ | 90 |
| 2 | TechCrunch Startups | rss | https://techcrunch.com/category/startups/feed/ | 80 |
| 3 | Hacker News (Best) | rss | https://hnrss.org/best | 70 |
| 4 | The Verge Tech | rss | https://www.theverge.com/rss/tech/index.xml | 60 |
| 5 | MIT Tech Review | rss | https://www.technologyreview.com/feed/ | 50 |
| 6 | a]16z Blog | rss | https://a16z.com/feed/ | 85 |

각 소스에 기본 crawl_policy:
```json
{
  "fetch_mode": "list_only",
  "max_items_per_run": 30,
  "recency_days": 7,
  "min_title_len": 12,
  "min_summary_len": 40,
  "block_keywords": ["sponsored","advertisement","promo","jobs","hiring","newsletter"],
  "translate_only_if": { "summary_char_limit": 600, "title_char_limit": 140 },
  "translation_budget": { "max_tokens_per_run": 20000, "max_tokens_per_item": 400 }
}
```

## 9. 폴더 구조 (최종)

```
instgram/
├── .env                        -- SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY
├── .github/
│   └── workflows/
│       └── daily-crawl.yml     -- GitHub Actions cron
├── supabase/
│   ├── schema.sql              -- V3 DDL + seed + indexes
│   └── migrations/             -- 추후 마이그레이션
├── lib/
│   ├── supabase.ts             -- Supabase client (server/client)
│   ├── types.ts                -- DB 타입 정의
│   ├── crawl/
│   │   ├── index.ts            -- orchestrator (crawlDaily)
│   │   ├── rss-fetcher.ts      -- RSS feed 파싱
│   │   ├── html-fetcher.ts     -- HTML list 파싱
│   │   ├── quality-filter.ts   -- 품질 필터 파이프라인
│   │   ├── hasher.ts           -- sha256 hash 유틸
│   │   └── translator.ts       -- OpenAI 번역 + budget guard
│   └── crawl/types.ts          -- 크롤링 관련 타입
├── app/
│   ├── layout.tsx
│   ├── page.tsx                -- 메인 리스트
│   ├── item/[id]/page.tsx      -- 상세
│   ├── sources/page.tsx
│   ├── runs/page.tsx
│   └── api/
│       └── crawl/route.ts      -- POST /api/crawl
├── package.json
├── tsconfig.json
├── next.config.js
└── tailwind.config.ts
```

## 10. 구현 순서 (Do Phase 가이드)

### Phase 1: 인프라 (Day 1)
- [ ] Next.js 프로젝트 초기화 (App Router + TypeScript + Tailwind)
- [ ] V3 schema.sql 작성 + Supabase에 배포
- [ ] Seed 소스 6건 INSERT
- [ ] Supabase client 설정 (lib/supabase.ts)
- [ ] .env에 OPENAI_API_KEY 추가

### Phase 2: 크롤러 코어 (Day 2)
- [ ] lib/crawl/rss-fetcher.ts — rss-parser 기반 피드 파싱
- [ ] lib/crawl/html-fetcher.ts — cheerio 기반 HTML 리스트 파싱 (stub)
- [ ] lib/crawl/hasher.ts — sha256 해시 유틸
- [ ] lib/crawl/quality-filter.ts — crawl_policy 기반 필터 파이프라인
- [ ] lib/crawl/translator.ts — OpenAI 배치 번역 + token budget
- [ ] lib/crawl/index.ts — orchestrator (crawlDaily 메인 함수)

### Phase 3: API + 스케줄 (Day 3)
- [ ] app/api/crawl/route.ts — POST endpoint
- [ ] dryRun 모드 구현
- [ ] .github/workflows/daily-crawl.yml 작성
- [ ] 로컬에서 curl로 테스트

### Phase 4: 뷰어 UI (Day 4~5)
- [ ] app/layout.tsx — 공통 레이아웃 + 네비게이션
- [ ] app/page.tsx — 메인 리스트 + 필터 + 페이지네이션
- [ ] app/item/[id]/page.tsx — 상세 페이지
- [ ] app/sources/page.tsx — 소스 관리
- [ ] app/runs/page.tsx — 크롤링 런 로그

### Phase 5: 검증 + 배포 (Day 6)
- [ ] 전체 크롤링 실행 (translate=true) + DB 검증
- [ ] Vercel 배포
- [ ] GitHub Actions cron 활성화
- [ ] 운영 체크리스트 점검

## 11. 기존 Python 코드 처리

| 파일 | 처리 |
|------|------|
| execution/scraper.py | 보관 (참고용) → 최종 삭제 |
| execution/storage.py | 보관 → lib/supabase.ts로 대체 |
| execution/translator.py | 보관 → lib/crawl/translator.ts로 대체 |
| execution/schema_v2.sql | 보관 → supabase/schema.sql(V3)로 대체 |
| execution/migrate_v2.sql | 보관 (마이그레이션 이력) |

## 12. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|--------|------|------|
| OpenAI API 비용 초과 | 번역 비용 폭발 | token budget 가드레일 필수 (20K/run) |
| RSS 피드 구조 변경 | 파싱 실패 | raw jsonb 보존 + crawl_logs error 기록 |
| 봇 차단 (403/캡차) | 소스 수집 불가 | 해당 소스 스킵 + 로그 + is_active 자동 비활성화 고려 |
| Supabase 무료 티어 한계 | DB 용량/API 제한 | list_only로 데이터 경량화, 오래된 items 주기적 정리 |
| 중복 번역 | 토큰 낭비 | hash+lang 기반 캐시 (unique constraint) |

## 13. 성공 기준

- [ ] 6개 RSS 소스에서 매일 자동 크롤링 동작
- [ ] 품질 필터 통과 아이템만 저장 (block_keywords, recency 등)
- [ ] 번역 token budget 초과 시 안전하게 스킵
- [ ] 웹 뷰어에서 필터/검색/페이지네이션 정상 동작
- [ ] crawl_runs/logs로 운영 상태 확인 가능
- [ ] dryRun 모드로 안전한 테스트 가능
