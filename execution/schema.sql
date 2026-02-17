-- Create table for YC Blog Articles
create table public.yc_articles (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  crawled_at timestamp with time zone default timezone('utc'::text, now()),
  
  title text not null,        -- Original Title
  title_kr text,              -- Translated Title (Korean)
  
  url text not null,
  author text,
  published_date date,
  excerpt text,
  
  content_en text,            -- Original Content
  content_kr text,            -- Translated Content (Korean)
  
  source_url text,

  constraint yc_articles_url_key unique (url)
);

alter table public.yc_articles enable row level security;
