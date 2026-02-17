import os
import sys
import hashlib
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

# Layer 3: Deterministic Execution — Schema V2
# Tables: sources, items, item_translations, crawl_runs, crawl_logs

def get_supabase_client():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")

    if not url or not key:
        print("Error: Supabase credentials not found in environment.", file=sys.stderr)
        return None

    return create_client(url, key)


def make_hash(canonical_url):
    """canonical_url 기반 sha256 해시 생성"""
    return hashlib.sha256(canonical_url.encode('utf-8')).hexdigest()


# ── Sources ──────────────────────────────────────────────────

def get_or_create_source(slug, name, source_type='html', base_url=None, crawl_policy=None):
    """소스 조회 또는 생성. 반환: source row dict or None"""
    supabase = get_supabase_client()
    if not supabase:
        return None

    res = supabase.table('sources').select('*').eq('slug', slug).execute()
    if res.data:
        return res.data[0]

    row = {
        'name': name,
        'slug': slug,
        'type': source_type,
        'base_url': base_url,
        'crawl_policy': crawl_policy or {},
    }
    res = supabase.table('sources').insert(row).execute()
    return res.data[0] if res.data else None


# ── Crawl Runs ───────────────────────────────────────────────

def start_crawl_run(source_id):
    """크롤링 런 시작. 반환: crawl_run row dict"""
    supabase = get_supabase_client()
    if not supabase:
        return None
    res = supabase.table('crawl_runs').insert({
        'source_id': source_id,
        'status': 'running',
    }).execute()
    return res.data[0] if res.data else None


def finish_crawl_run(run_id, status, items_found=0, items_created=0, items_updated=0, items_skipped=0, error_message=None):
    """크롤링 런 종료"""
    supabase = get_supabase_client()
    if not supabase:
        return
    supabase.table('crawl_runs').update({
        'status': status,
        'finished_at': 'now()',
        'items_found': items_found,
        'items_created': items_created,
        'items_updated': items_updated,
        'items_skipped': items_skipped,
        'error_message': error_message,
    }).eq('id', run_id).execute()


# ── Crawl Logs ───────────────────────────────────────────────

def log_crawl(crawl_run_id, url, status='success', item_id=None, error_message=None):
    """아이템별 크롤링 로그 기록"""
    supabase = get_supabase_client()
    if not supabase:
        return
    supabase.table('crawl_logs').insert({
        'crawl_run_id': crawl_run_id,
        'url': url,
        'status': status,
        'item_id': item_id,
        'error_message': error_message,
    }).execute()


# ── Items — Upsert ───────────────────────────────────────────

def upsert_item(source_id, data):
    """
    items 테이블에 upsert (hash 기반 멱등성).
    data = {title, summary, author, published_at, canonical_url, content_text, language, raw, source_item_id}
    반환: (item_row, 'created'|'updated'|'skipped') or (None, 'error')
    """
    supabase = get_supabase_client()
    if not supabase:
        return None, 'error'

    canonical_url = data.get('canonical_url', '')
    item_hash = make_hash(canonical_url)

    row = {
        'source_id': source_id,
        'source_item_id': data.get('source_item_id'),
        'title': data['title'],
        'summary': data.get('summary'),
        'author': data.get('author'),
        'language': data.get('language', 'en'),
        'published_at': data.get('published_at'),
        'canonical_url': canonical_url,
        'content_text': data.get('content_text'),
        'content_html': data.get('content_html'),
        'raw': data.get('raw', {}),
        'hash': item_hash,
    }

    try:
        res = supabase.table('items').upsert(row, on_conflict='hash').execute()
        if res.data:
            return res.data[0], 'created'
        return None, 'skipped'
    except Exception as e:
        print(f"Error upserting item: {e}", file=sys.stderr)
        return None, 'error'


# ── Translations — Upsert ────────────────────────────────────

def upsert_translation(item_id, lang, title=None, summary=None, content=None, translator='gemini-2.0-flash'):
    """item_translations에 upsert (item_id + lang unique)"""
    supabase = get_supabase_client()
    if not supabase:
        return False

    row = {
        'item_id': item_id,
        'lang': lang,
        'title': title,
        'summary': summary,
        'content': content,
        'translator': translator,
    }

    try:
        supabase.table('item_translations').upsert(row, on_conflict='item_id,lang').execute()
        return True
    except Exception as e:
        print(f"Error upserting translation: {e}", file=sys.stderr)
        return False


# ── Legacy compat ────────────────────────────────────────────

def save_crawled_data(table_name, data):
    """V1 호환용 — 기존 yc_articles 직접 upsert"""
    supabase = get_supabase_client()
    if not supabase:
        return False
    try:
        supabase.table(table_name).upsert(data, on_conflict='url').execute()
        return True
    except Exception as e:
        print(f"Error saving to Supabase: {e}", file=sys.stderr)
        return False


if __name__ == "__main__":
    client = get_supabase_client()
    if client:
        print("Supabase connection successful.")
    else:
        print("Supabase connection failed.")
