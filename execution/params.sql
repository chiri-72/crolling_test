-- Enable RLS (already done, but good to be safe)
alter table public.yc_articles enable row level security;

-- Allow anonymous inserts (for the scraper)
create policy "Enable insert for everyone" 
on public.yc_articles 
for insert 
with check (true);

-- Allow anonymous selects (to verify data)
create policy "Enable select for everyone" 
on public.yc_articles 
for select 
using (true);

-- Allow anonymous updates (for upsert)
create policy "Enable update for everyone" 
on public.yc_articles 
for update 
using (true)
with check (true);
