-- ============================================================
-- Schema V2: Multi-Source Startup Intelligence Platform
-- ============================================================
-- Supabase (Postgres 15+)
-- Requires: pgcrypto extension (enabled by default on Supabase)
-- ============================================================

-- 0. Extension
-- ============================================================
create extension if not exists pgcrypto;

-- ============================================================
-- A) sources — 채널/소스 레지스트리
-- ============================================================
create table public.sources (
  id          uuid default gen_random_uuid() primary key,
  name        text not null,                          -- "YC Blog", "TechCrunch", "Hacker News"
  slug        text not null unique,                   -- "yc-blog", "techcrunch", "hackernews"
  type        text not null default 'html'
              check (type in ('rss','html','api','community','manual')),
  base_url    text,                                   -- "https://www.ycombinator.com/blog"
  description text,
  crawl_policy jsonb not null default '{}'::jsonb,    -- {"rate_limit_ms":5000,"selectors":{},...}
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on column public.sources.crawl_policy is
  'JSON: rate_limit_ms, selectors, headers, api_mapping, schedule_cron 등';

-- ============================================================
-- B) items — 모든 소스의 콘텐츠를 담는 중앙 테이블
-- ============================================================
create table public.items (
  id              uuid default gen_random_uuid() primary key,
  source_id       uuid not null references public.sources(id) on delete cascade,
  source_item_id  text,                               -- 소스 내 고유 ID (있으면)

  -- 표준화 필드
  title           text not null,
  summary         text,                               -- excerpt / 요약
  author          text,
  language        text not null default 'en',          -- ISO 639-1
  published_at    timestamptz,
  canonical_url   text,

  -- 본문
  content_text    text,                               -- plain text
  content_html    text,                               -- optional raw HTML

  -- 원본 보존
  raw             jsonb not null default '{}'::jsonb,  -- 소스별 원본 필드 전부

  -- 중복 방지 해시
  hash            text not null,                       -- sha256(canonical_url) or sha256(source_id::source_item_id)

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 핵심 인덱스
create unique index idx_items_hash          on public.items (hash);
create index idx_items_source_id            on public.items (source_id);
create index idx_items_published_at         on public.items (published_at desc nulls last);
create index idx_items_canonical_url        on public.items (canonical_url);
create index idx_items_language             on public.items (language);
create index idx_items_source_published     on public.items (source_id, published_at desc nulls last);

-- ============================================================
-- C) item_translations — 번역 테이블
-- ============================================================
create table public.item_translations (
  id              uuid default gen_random_uuid() primary key,
  item_id         uuid not null references public.items(id) on delete cascade,
  lang            text not null default 'ko',         -- ISO 639-1 target language
  title           text,
  summary         text,
  content         text,
  translator      text default 'gemini-2.0-flash',    -- 번역 서비스/모델
  translated_at   timestamptz not null default now(),

  constraint uq_item_translations_item_lang unique (item_id, lang)
);

create index idx_item_translations_item_id on public.item_translations (item_id);

-- ============================================================
-- D) entities — 회사, 인물, 조직
-- ============================================================
create table public.entities (
  id          uuid default gen_random_uuid() primary key,
  name        text not null,
  type        text not null default 'company'
              check (type in ('company','person','organization','product')),
  slug        text not null unique,                   -- URL-safe identifier
  metadata    jsonb not null default '{}'::jsonb,      -- website, logo, founded_year 등
  created_at  timestamptz not null default now()
);

create index idx_entities_type on public.entities (type);

-- ============================================================
-- E) item_entities — items ↔ entities (M:N)
-- ============================================================
create table public.item_entities (
  item_id     uuid not null references public.items(id) on delete cascade,
  entity_id   uuid not null references public.entities(id) on delete cascade,
  role        text not null default 'mentioned'
              check (role in ('mentioned','founded','invested','acquired','partnered')),
  primary key (item_id, entity_id, role)
);

create index idx_item_entities_entity_id on public.item_entities (entity_id);

-- ============================================================
-- F) tags — 태그/카테고리
-- ============================================================
create table public.tags (
  id          uuid default gen_random_uuid() primary key,
  name        text not null unique,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- G) item_tags — items ↔ tags (M:N)
-- ============================================================
create table public.item_tags (
  item_id     uuid not null references public.items(id) on delete cascade,
  tag_id      uuid not null references public.tags(id) on delete cascade,
  primary key (item_id, tag_id)
);

create index idx_item_tags_tag_id on public.item_tags (tag_id);

-- ============================================================
-- H) crawl_runs — 크롤링 실행 단위
-- ============================================================
create table public.crawl_runs (
  id              uuid default gen_random_uuid() primary key,
  source_id       uuid not null references public.sources(id) on delete cascade,
  status          text not null default 'running'
                  check (status in ('running','completed','failed','cancelled')),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  items_found     int not null default 0,
  items_created   int not null default 0,
  items_updated   int not null default 0,
  items_skipped   int not null default 0,
  error_message   text
);

create index idx_crawl_runs_source_id   on public.crawl_runs (source_id);
create index idx_crawl_runs_started_at  on public.crawl_runs (started_at desc);

-- ============================================================
-- I) crawl_logs — 크롤링 아이템별 상세 로그
-- ============================================================
create table public.crawl_logs (
  id              uuid default gen_random_uuid() primary key,
  crawl_run_id    uuid not null references public.crawl_runs(id) on delete cascade,
  item_id         uuid references public.items(id) on delete set null,
  url             text,
  status          text not null default 'success'
                  check (status in ('success','skipped','error')),
  error_message   text,
  created_at      timestamptz not null default now()
);

create index idx_crawl_logs_run_id  on public.crawl_logs (crawl_run_id);
create index idx_crawl_logs_item_id on public.crawl_logs (item_id);

-- ============================================================
-- Trigger: auto-update updated_at
-- ============================================================
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_sources_updated_at
  before update on public.sources
  for each row execute function public.set_updated_at();

create trigger trg_items_updated_at
  before update on public.items
  for each row execute function public.set_updated_at();

-- ============================================================
-- RLS Policies (anon access for scraper)
-- ============================================================
alter table public.sources            enable row level security;
alter table public.items              enable row level security;
alter table public.item_translations  enable row level security;
alter table public.entities           enable row level security;
alter table public.item_entities      enable row level security;
alter table public.tags               enable row level security;
alter table public.item_tags          enable row level security;
alter table public.crawl_runs         enable row level security;
alter table public.crawl_logs         enable row level security;

-- 모든 테이블에 anon CRUD 허용 (scraper용; 프로덕션에서는 service_role로 전환)
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'sources','items','item_translations','entities',
    'item_entities','tags','item_tags','crawl_runs','crawl_logs'
  ]) loop
    execute format(
      'create policy "anon_select_%1$s" on public.%1$s for select using (true)', t);
    execute format(
      'create policy "anon_insert_%1$s" on public.%1$s for insert with check (true)', t);
    execute format(
      'create policy "anon_update_%1$s" on public.%1$s for update using (true) with check (true)', t);
  end loop;
end $$;
