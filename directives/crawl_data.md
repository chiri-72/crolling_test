# YC Blog Crawling Directive

## Goal
Routinely fetch the latest articles from [Y Combinator Blog](https://www.ycombinator.com/blog) and archive them to Supabase.

## Target
- **URL**: `https://www.ycombinator.com/blog`
- **Frequency**: Daily (Routine)

## Data Schema (Supabase Table: `yc_articles`)
- `id`: UUID (Primary Key, default: gen_random_uuid())
- `title`: Text (Article Title)
- `url`: Text (Unique Constraint)
- `author`: Text
- `published_date`: Date
- `excerpt`: Text (Short summary/lead)
- `content`: Text (Full content - *Future Scope*)
- `crawled_at`: Timestamp (default: now())

## Execution Steps
1. **Fetch**: Request `https://www.ycombinator.com/blog`.
2. **Parse**:
    - **Container**: `div` containing post info (Look for class patterns like `prose` or specific layout blocks).
    - **Title**: `h2` or `a` tags within the container.
    - **URL**: `href` attribute from the title link.
    - **Author/Date**: Often in a strictly formatted span or div below title.
3. **Store**: Upsert to `yc_articles` table based on `url` to prevent duplicates.

## Error Handling
- **Network Error**: Retry 3 times.
- **Parse Error**: Skip individual article, log warning, continue to next.
