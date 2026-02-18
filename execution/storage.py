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

def get_or_create_source(slug, name, source_type='html', base_url=None, seed_url=None, crawl_policy=None):
    """소스 조회 또는 생성. 반환: source row dict or None"""
    supabase = get_supabase_client()
    if not supabase:
        return None

    # 현재 DB 스키마에 slug 컬럼이 없는 경우를 대비하여 name으로 조회
    try:
        res = supabase.table('sources').select('*').eq('name', name).execute()
    except Exception:
        # slug 컬럼이 있는 경우를 위한 fallback (V2 스키마 준수 시)
        res = supabase.table('sources').select('*').eq('slug', slug).execute()

    if res.data:
        return res.data[0]

    row = {
        'name': name,
        #'slug': slug, 
        'type': source_type,
        'base_url': base_url,
        'seed_url': seed_url,
        'crawl_policy': crawl_policy or {},
    }
    # DB 스키마에 따라 slug 포함 여부 결정 (현재는 name 기반으로만 동작 확인됨)
    res = supabase.table('sources').insert(row).execute()
    return res.data[0] if res.data else None


# ── Crawl Runs ───────────────────────────────────────────────

def start_crawl_run(source_id=None):
    """크롤링 런 시작. 반환: crawl_run row dict"""
    supabase = get_supabase_client()
    if not supabase:
        return None
    # 현재 DB 스키마: source_id가 없고 status만 존재함
    res = supabase.table('crawl_runs').insert({
        'status': 'running',
        'started_at': 'now()',
    }).execute()
    return res.data[0] if res.data else None


def finish_crawl_run(run_id, status, items_found=0, items_created=0, items_updated=0, items_skipped=0, error_message=None):
    """크롤링 런 종료"""
    supabase = get_supabase_client()
    if not supabase:
        return
    # 현재 DB 스키마 필드명 대응
    data = {
        'status': 'success' if status == 'completed' else 'fail',
        'ended_at': 'now()',
        'items_found': items_found,
        'items_saved': items_created + items_updated, # items_created -> items_saved
    }
    # error_message 필드가 없을 수 있으므로 로그로 대체하거나 처리
    try:
        supabase.table('crawl_runs').update(data).eq('id', run_id).execute()
    except Exception as e:
        print(f"Error updating crawl_run: {e}", file=sys.stderr)


# ── Crawl Logs ───────────────────────────────────────────────

def log_crawl(crawl_run_id, url, status='success', item_id=None, error_message=None):
    """아이템별 크롤링 로그 기록"""
    supabase = get_supabase_client()
    if not supabase:
        return
    # 현재 DB 스키마: crawl_run_id -> run_id, status -> level 등
    try:
        supabase.table('crawl_logs').insert({
            'run_id': crawl_run_id,
            'level': 'info' if status == 'success' else 'error',
            'message': f"URL: {url} | Status: {status} | Error: {error_message}" if error_message else f"URL: {url} success",
            'meta': {'url': url, 'item_id': item_id}
        }).execute()
    except Exception as e:
        print(f"Error logging crawl: {e}", file=sys.stderr)


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
        # 'content_text': data.get('content_text'), # DB에 없음
        # 'content_html': data.get('content_html'), # DB에 없음
        'raw': data.get('raw', {}),
        'hash': item_hash,
    }

    try:
        # Debug: Check if canonical_url is missing
        if not canonical_url:
             print(f"Warning: canonical_url is empty for item '{data['title']}'", file=sys.stderr)

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

    # 현재 DB 스키마 필드명 대응: title -> title_translated
    row = {
        'item_id': item_id,
        'lang': lang,
        'title_translated': title,
        'summary_translated': summary,
        'provider': 'gemini',
        'model': translator,
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
