-- ============================================================
-- Schema V3: Startup Intelligence — list_only + translation
-- ============================================================

create extension if not exists pgcrypto;

-- ── A) sources ──────────────────────────────────────────────
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

-- ── B) items ────────────────────────────────────────────────
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

-- ── C) item_translations ────────────────────────────────────
create table public.item_translations (
  id                  uuid default gen_random_uuid() primary key,
  item_id             uuid not null references public.items(id) on delete cascade,
  lang                text not null default 'ko',
  title_translated    text,
  summary_translated  text,
  provider            text not null default 'gemini',
  model               text not null default 'gemini-2.0-flash',
  tokens_used         int,
  translated_at       timestamptz not null default now(),
  constraint uq_item_translation unique (item_id, lang)
);

create index idx_item_translations_item
  on public.item_translations (item_id);

-- ── D) crawl_runs ───────────────────────────────────────────
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

-- ── E) crawl_logs ───────────────────────────────────────────
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

-- ── Trigger: updated_at ─────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger trg_items_updated
  before update on public.items
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────
alter table public.sources           enable row level security;
alter table public.items             enable row level security;
alter table public.item_translations enable row level security;
alter table public.crawl_runs        enable row level security;
alter table public.crawl_logs        enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array[
    'sources','items','item_translations','crawl_runs','crawl_logs'
  ]) loop
    execute format(
      'create policy "anon_read_%1$s" on public.%1$s for select using (true)', t);
    execute format(
      'create policy "service_all_%1$s" on public.%1$s for all using (true) with check (true)', t);
  end loop;
end $$;

-- ── Seed: 6 RSS Sources ─────────────────────────────────────
insert into public.sources (name, type, seed_url, base_url, priority, crawl_policy)
values
  ('YC Blog', 'rss',
   'https://www.ycombinator.com/blog/rss/',
   'https://www.ycombinator.com/blog', 90,
   '{"fetch_mode":"list_only","max_items_per_run":30,"recency_days":7,"min_title_len":12,"min_summary_len":20,"block_keywords":["sponsored","advertisement","promo","jobs","hiring"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),

  ('a16z Blog', 'rss',
   'https://speedrun.substack.com/feed',
   'https://speedrun.substack.com', 85,
   '{"fetch_mode":"list_only","max_items_per_run":30,"recency_days":7,"min_title_len":12,"min_summary_len":20,"block_keywords":["sponsored","advertisement","promo","newsletter"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),

  ('TechCrunch Startups', 'rss',
   'https://techcrunch.com/category/startups/feed/',
   'https://techcrunch.com', 80,
   '{"fetch_mode":"list_only","max_items_per_run":30,"recency_days":7,"min_title_len":12,"min_summary_len":40,"block_keywords":["sponsored","advertisement","promo","jobs","hiring","newsletter"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),

  ('Hacker News Best', 'rss',
   'https://hnrss.org/best',
   'https://news.ycombinator.com', 70,
   '{"fetch_mode":"list_only","max_items_per_run":30,"recency_days":3,"min_title_len":10,"min_summary_len":0,"block_keywords":["hiring","job","ask hn: who is hiring"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),

  ('The Verge Tech', 'rss',
   'https://www.theverge.com/rss/tech/index.xml',
   'https://www.theverge.com', 60,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":3,"min_title_len":12,"min_summary_len":30,"block_keywords":["sponsored","advertisement","deal","sale"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),

  ('MIT Tech Review', 'rss',
   'https://www.technologyreview.com/feed/',
   'https://www.technologyreview.com', 50,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":7,"min_title_len":12,"min_summary_len":40,"block_keywords":["sponsored","advertisement","promo","newsletter","podcast"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb);

insert into public.sources (name, type, seed_url, base_url, priority, crawl_policy)
values
  ('Y Combinator YouTube', 'youtube', 'https://www.youtube.com/@ycombinator/videos', 'https://www.youtube.com/@ycombinator', 68,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":14,"min_title_len":6,"min_summary_len":0,"require_fields":["title","canonical_url"],"block_keywords":["livestream","sponsored"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),
  ('Sequoia Capital YouTube', 'youtube', 'https://www.youtube.com/@SequoiaCapital/videos', 'https://www.youtube.com/@SequoiaCapital', 67,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":14,"min_title_len":6,"min_summary_len":0,"require_fields":["title","canonical_url"],"block_keywords":["livestream","sponsored"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),
  ('a16z YouTube', 'youtube', 'https://www.youtube.com/@a16z/videos', 'https://www.youtube.com/@a16z', 66,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":14,"min_title_len":6,"min_summary_len":0,"require_fields":["title","canonical_url"],"block_keywords":["livestream","sponsored"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),
  ('Bloomberg Tech YouTube', 'youtube', 'https://www.youtube.com/bloombergtech', 'https://www.youtube.com/bloombergtech', 65,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":14,"min_title_len":6,"min_summary_len":0,"require_fields":["title","canonical_url"],"block_keywords":["livestream","sponsored"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),
  ('CNBC Make It YouTube', 'youtube', 'https://www.youtube.com/@CNBCMakeIt/videos', 'https://www.youtube.com/@CNBCMakeIt', 64,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":14,"min_title_len":6,"min_summary_len":0,"require_fields":["title","canonical_url"],"block_keywords":["livestream","sponsored"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),
  ('Lex Fridman YouTube', 'youtube', 'https://www.youtube.com/@lexfridman/videos', 'https://www.youtube.com/@lexfridman', 63,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":14,"min_title_len":6,"min_summary_len":0,"require_fields":["title","canonical_url"],"block_keywords":["livestream","sponsored"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),
  ('Ali Abdaal YouTube', 'youtube', 'https://www.youtube.com/@AliAbdaal/videos', 'https://www.youtube.com/@AliAbdaal', 62,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":14,"min_title_len":6,"min_summary_len":0,"require_fields":["title","canonical_url"],"block_keywords":["livestream","sponsored"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),
  ('Lenny''s Podcast YouTube', 'youtube', 'https://www.youtube.com/@LennysPodcast/videos', 'https://www.youtube.com/@LennysPodcast', 61,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":14,"min_title_len":6,"min_summary_len":0,"require_fields":["title","canonical_url"],"block_keywords":["livestream","sponsored"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb),
  ('Startups YouTube', 'youtube', 'https://www.youtube.com/@startups/videos', 'https://www.youtube.com/@startups', 60,
   '{"fetch_mode":"list_only","max_items_per_run":20,"recency_days":14,"min_title_len":6,"min_summary_len":0,"require_fields":["title","canonical_url"],"block_keywords":["livestream","sponsored"],"translate_only_if":{"summary_char_limit":600,"title_char_limit":140},"translation_budget":{"max_tokens_per_run":20000,"max_tokens_per_item":400}}'::jsonb);
