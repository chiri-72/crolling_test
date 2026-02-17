-- ============================================================
-- Migration: yc_articles → Schema V2
-- ============================================================
-- 실행 순서: schema_v2.sql 먼저 실행 후 이 파일 실행
-- ============================================================

-- 1) sources: YC Blog 소스 등록
-- ============================================================
insert into public.sources (name, slug, type, base_url, description, crawl_policy)
values (
  'YC Blog',
  'yc-blog',
  'html',
  'https://www.ycombinator.com/blog',
  'Y Combinator official blog',
  '{
    "rate_limit_ms": 5000,
    "max_items_per_run": 50,
    "selectors": {
      "list_card": "div.flex.flex-col.overflow-hidden.rounded.shadow-sm",
      "title": "p.text-xl",
      "link": "a.mt-2.block",
      "excerpt": "p.mt-3",
      "author": "p.text-sm.font-medium.text-gray-800",
      "content": "div.prose, article"
    }
  }'::jsonb
);

-- 2) items: yc_articles → items 마이그레이션
-- ============================================================
insert into public.items (
  source_id,
  source_item_id,
  title,
  summary,
  author,
  language,
  published_at,
  canonical_url,
  content_text,
  raw,
  hash,
  created_at,
  updated_at
)
select
  (select id from public.sources where slug = 'yc-blog'),
  -- source_item_id: URL의 마지막 path segment
  regexp_replace(ya.url, '^.+/', ''),
  ya.title,
  ya.excerpt,
  ya.author,
  'en',
  ya.published_date::timestamptz,
  ya.url,
  ya.content_en,
  jsonb_build_object(
    'source_url',   ya.source_url,
    'crawled_at',   ya.crawled_at,
    'original_id',  ya.id
  ),
  encode(digest(ya.url, 'sha256'), 'hex'),
  coalesce(ya.created_at, now()),
  coalesce(ya.crawled_at, now())
from public.yc_articles ya
on conflict (hash) do nothing;

-- 3) item_translations: title_kr / content_kr → 한국어 번역
-- ============================================================
insert into public.item_translations (item_id, lang, title, summary, content, translator, translated_at)
select
  i.id,
  'ko',
  ya.title_kr,
  null,  -- excerpt_kr 없었음
  ya.content_kr,
  'gemini-2.0-flash',
  coalesce(ya.crawled_at, now())
from public.yc_articles ya
join public.items i on i.canonical_url = ya.url
where ya.title_kr is not null or ya.content_kr is not null
on conflict (item_id, lang) do update set
  title   = excluded.title,
  content = excluded.content;

-- 4) 검증 쿼리
-- ============================================================
-- 마이그레이션 후 데이터 확인용 (실행 결과만 확인, 변경 없음)
select
  i.title,
  i.canonical_url,
  i.language,
  t.lang as translation_lang,
  left(t.title, 40) as title_kr,
  length(t.content) as content_kr_len,
  s.name as source_name
from public.items i
join public.sources s on s.id = i.source_id
left join public.item_translations t on t.item_id = i.id
order by i.published_at desc;

-- 5) (선택) 기존 테이블 보존 — 검증 완료 후 삭제
-- ============================================================
-- 바로 삭제하지 않고 rename하여 백업으로 보존
-- alter table public.yc_articles rename to _yc_articles_backup;
