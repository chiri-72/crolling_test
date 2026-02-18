import os
import re
import sys
import time
import requests
from bs4 import BeautifulSoup
from datetime import datetime
from dotenv import load_dotenv

from storage import (
    get_or_create_source, upsert_item, upsert_translation,
    start_crawl_run, finish_crawl_run, log_crawl,
)
from translator import translate_text
from proxy_utility import get_request_params

load_dotenv()

# Layer 3: Deterministic Execution
# Target: Y Combinator Blog (List + Detail)
# Schema: V2 (sources → items → item_translations + crawl_runs/logs)

# ── Source Configs ───────────────────────────────────────────

YC_SOURCE = {
    'slug': 'yc-blog',
    'name': 'YC Blog',
    'source_type': 'html',
    'base_url': 'https://www.ycombinator.com/blog',
    'crawl_policy': {
        'rate_limit_ms': 5000,
        'max_items_per_run': 50,
        'selectors': {
            'list_card': 'div.flex.flex-col.overflow-hidden.rounded.shadow-sm',
            'title': 'p.text-xl',
            'link': 'a.mt-2.block',
            'excerpt': 'p.mt-3',
            'author': 'p.text-sm.font-medium.text-gray-800',
            'content': 'div.prose, article',
        },
    },
}

VB_SOURCE = {
    'slug': 'venturebeat-startups',
    'name': 'VentureBeat Startups',
    'source_type': 'rss',
    'base_url': 'https://venturebeat.com',
    'seed_url': 'https://venturebeat.com/feed/',
    'crawl_policy': {'rate_limit_ms': 3000, 'max_items_per_run': 20},
}

TC_SOURCE = {
    'slug': 'techcrunch-startups',
    'name': 'TechCrunch Startups',
    'source_type': 'rss',
    'base_url': 'https://techcrunch.com',
    'seed_url': 'https://techcrunch.com/category/startups/feed/',
    'crawl_policy': {'rate_limit_ms': 3000, 'max_items_per_run': 20},
}

SIFTED_SOURCE = {
    'slug': 'sifted',
    'name': 'Sifted',
    'source_type': 'rss',
    'base_url': 'https://sifted.eu',
    'seed_url': 'https://sifted.eu/feed',
    'crawl_policy': {'rate_limit_ms': 3000, 'max_items_per_run': 20},
}

TIA_SOURCE = {
    'slug': 'tech-in-asia',
    'name': 'Tech in Asia',
    'source_type': 'rss',
    'base_url': 'https://www.techinasia.com',
    'seed_url': 'https://www.techinasia.com/feed',
    'crawl_policy': {'rate_limit_ms': 3000, 'max_items_per_run': 20},
}

GW_SOURCE = {
    'slug': 'geekwire-startups',
    'name': 'GeekWire Startups',
    'source_type': 'rss',
    'base_url': 'https://www.geekwire.com',
    'seed_url': 'http://www.geekwire.com/startups/feed',
    'crawl_policy': {'rate_limit_ms': 3000, 'max_items_per_run': 20},
}

EU_SOURCE = {
    'slug': 'eu-startups',
    'name': 'EU-Startups',
    'source_type': 'rss',
    'base_url': 'https://www.eu-startups.com',
    'seed_url': 'https://www.eu-startups.com/feed',
    'crawl_policy': {'rate_limit_ms': 3000, 'max_items_per_run': 20},
}

YT_YC_SOURCE = {
    'slug': 'yc-youtube',
    'name': 'Y Combinator (YouTube)',
    'source_type': 'rss', # DB 제약 조건(sources_type_check) 준수
    'parser_type': 'youtube', 
    'base_url': 'https://www.youtube.com',
    'seed_url': 'https://www.youtube.com/feeds/videos.xml?channel_id=UCcefcZRL2oaA_uBNeo5UOWg',
    'crawl_policy': {'rate_limit_ms': 2000, 'max_items_per_run': 10},
}


# ── HTTP Fetch ───────────────────────────────────────────────

def fetch_page(url, retries=3):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36'
    }
    
    for attempt in range(retries):
        try:
            params = get_request_params(url)
            # proxy_utility에서 생성한 params를 사용하여 요청
            response = requests.get(
                params["url"], 
                proxies=params["proxies"], 
                headers=headers, 
                timeout=params["timeout"]
            )
            response.raise_for_status()
            return response.text
        except Exception as e:
            print(f"Attempt {attempt + 1} failed for {url}: {e}", file=sys.stderr)
            if attempt == retries - 1:
                return None
            time.sleep(2) # 재시도 전 대기
    return None


# ── Parsers ──────────────────────────────────────────────────

def parse_article_detail(url):
    html = fetch_page(url)
    if not html:
        return None

    soup = BeautifulSoup(html, 'html.parser')
    article_body = soup.find('div', class_=lambda x: x and 'prose' in x)
    if not article_body:
        article_body = soup.find('article')

    if article_body:
        return article_body.get_text("\n\n", strip=True)
    return ""


def parse_yc_blog_list(html):
    soup = BeautifulSoup(html, 'html.parser')
    articles = []

    # Strategy 1: Grid cards
    for card in soup.find_all('div', class_='flex flex-col overflow-hidden rounded shadow-sm'):
        try:
            link_tag = card.find('a', class_='mt-2 block')
            if not link_tag:
                continue

            title_tag = link_tag.find('p', class_='text-xl')
            if not title_tag:
                continue

            title = title_tag.get_text(strip=True)
            url = link_tag.get('href')
            if not url.startswith('http'):
                url = f"https://www.ycombinator.com{url}"

            excerpt_tag = link_tag.find('p', class_='mt-3')
            excerpt = excerpt_tag.get_text(strip=True) if excerpt_tag else ""

            author = "YC"
            date = datetime.now().strftime("%Y-%m-%d")

            meta_div = card.find('div', class_='mt-6 flex items-center')
            if meta_div:
                author_tag = meta_div.find('p', class_='text-sm font-medium text-gray-800')
                if author_tag:
                    author = author_tag.get_text(strip=True)

                date_div = meta_div.find('div', class_='text-gray-500')
                if date_div:
                    date_text = date_div.get_text(strip=True)
                    try:
                        dt = datetime.strptime(date_text, "%m/%d/%Y")
                        date = dt.strftime("%Y-%m-%d")
                    except:
                        pass

            articles.append({
                "title": title,
                "url": url,
                "author": author,
                "published_date": date,
                "excerpt": excerpt,
            })

        except Exception as e:
            print(f"Error parsing item: {e}", file=sys.stderr)
            continue

    # Strategy 2: h2 fallback
    if not articles:
        for h2 in soup.find_all('h2'):
            try:
                parent_a = h2.find_parent('a')
                if parent_a:
                    title = h2.get_text(strip=True)
                    url = parent_a.get('href')
                    if not url.startswith('http'):
                        url = f"https://www.ycombinator.com{url}"
                    articles.append({
                        "title": title,
                        "url": url,
                        "author": "YC",
                        "published_date": datetime.now().strftime("%Y-%m-%d"),
                        "excerpt": "",
                    })
            except:
                continue
    return articles

def parse_rss_feed(xml_content):
    try:
        soup = BeautifulSoup(xml_content, 'xml')
    except Exception:
        soup = BeautifulSoup(xml_content, 'html.parser')
    items = []
    for entry in soup.find_all('item'):
        title = entry.find('title').get_text() if entry.find('title') else ""
        link_tag = entry.find('link')
        if link_tag:
            link = link_tag.get_text().strip()
            # html.parser가 <link/>URL 형식으로 잘못 파싱하는 경우 대비
            if not link:
                # 1. <link>URL</link> 또는 <link/>URL 형태 모두 지원
                match = re.search(r'<link[^>]*?>(.*?)</link>|<link/>\s*([^\s<]+)', str(entry), re.I | re.S)
                if match:
                    link = (match.group(1) or match.group(2)).strip()
                else:
                    link = link_tag.get('href', "").strip()
        else:
            link = ""
        
        description = entry.find('description').get_text() if entry.find('description') else ""
        author = entry.find('dc:creator').get_text() if entry.find('dc:creator') else "Unknown"
        
        # 날짜 태그 다양하게 시도
        pub_date_tag = entry.find('pubDate') or entry.find('pubdate') or entry.find('published')
        if not pub_date_tag:
             pub_date_tag = entry.find('dc:date')
        
        pub_date = pub_date_tag.get_text() if pub_date_tag else ""
        
        items.append({
            "title": title,
            "url": link,
            "author": author,
            "published_date": pub_date,
            "excerpt": description,
        })
    return items

def parse_youtube_rss(xml_content):
    try:
        soup = BeautifulSoup(xml_content, 'xml')
    except Exception:
        soup = BeautifulSoup(xml_content, 'html.parser')
    items = []
    for entry in soup.find_all('entry'):
        video_id = entry.find('yt:videoId').get_text() if entry.find('yt:videoId') else ""
        title = entry.find('title').get_text() if entry.find('title') else ""
        link_tag = entry.find('link')
        if link_tag:
            link = link_tag.get('href', "").strip()
            if not link:
                link = link_tag.get_text().strip()
            if not link:
                # 유튜브 RSS 특유의 <link rel="alternate" href="..."/> 패턴 대응
                match = re.search(r'<link.*?href=[\"\'](.*?)[\"\']', str(entry), re.I)
                if not match:
                    match = re.search(r'<link[^>]*?>(.*?)</link>|<link/>\s*([^\s<]+)', str(entry), re.I | re.S)
                if match:
                    link = (match.group(1) or (match.groups()[-1] if len(match.groups()) > 1 else "")).strip()
        else:
            link = ""
        
        author = entry.find('author').find('name').get_text() if entry.find('author') else "Unknown"
        pub_date = entry.find('published').get_text() if entry.find('published') else ""
        
        # summary에 임베드 코드를 넣어 프론트엔드에서 처리할 수 있게 함
        embed_url = f"https://www.youtube.com/embed/{video_id}"
        items.append({
            "title": title,
            "url": link,
            "author": author,
            "published_date": pub_date,
            "excerpt": f"[VIDEO_EMBED]{embed_url}",
        })
    return items


# ── Main Pipeline ────────────────────────────────────────────

def run_source_crawl(source_config, max_items=3):
    """범용 소스 크롤링 파이프라인"""
    # 인자 필터링 (get_or_create_source에 필요한 것만 전달)
    source = get_or_create_source(
        slug=source_config['slug'],
        name=source_config['name'],
        source_type=source_config['source_type'],
        base_url=source_config['base_url'],
        seed_url=source_config.get('seed_url'),
        crawl_policy=source_config.get('crawl_policy')
    )
    if not source:
        print(f"Failed to get/create source: {source_config['name']}", file=sys.stderr)
        return
    source_id = source['id']
    print(f"\nSource: {source['name']} ({source_id})")

    run = start_crawl_run(source_id)
    if not run:
        print("Failed to start crawl run.", file=sys.stderr)
        return
    run_id = run['id']
    print(f"Crawl Run started: {run_id}")

    target_url = source_config.get('seed_url') or source_config['base_url']
    print(f"Fetching from {target_url}...")
    content = fetch_page(target_url)
    if not content:
        finish_crawl_run(run_id, 'failed', error_message='Failed to fetch seed page')
        return

    if source_config.get('parser_type') == 'youtube':
        articles = parse_youtube_rss(content)
    elif source_config['source_type'] == 'rss':
        articles = parse_rss_feed(content)
    else:
        articles = parse_yc_blog_list(content)
        
    items_found = len(articles)
    print(f"Found {items_found} articles.")

    created = updated = skipped = 0
    rate_limit_s = source_config['crawl_policy'].get('rate_limit_ms', 3000) / 1000

    for article in articles[:max_items]:
        print(f"\nProcessing: {article['title']}")
        try:
            # RSS인 경우 이미 요약이 있는 경우가 많으므로 detail fetch 생략 가능 (필요시 추가)
            content_text = ""
            if source_config['source_type'] != 'rss':
                content_text = parse_article_detail(article['url'])

            item_data = {
                'title': article['title'],
                'summary': article.get('excerpt'),
                'author': article.get('author'),
                'published_at': article.get('published_date') if article.get('published_date') else datetime.now().isoformat(),
                'canonical_url': article['url'],
                'content_text': content_text,
                'language': 'en',
                'source_item_id': article['url'].rstrip('/').split('/')[-1],
                'raw': {
                    'source_url': source_config['base_url'],
                    'crawled_at': datetime.now().isoformat(),
                },
            }

            item, action = upsert_item(source_id, item_data)
            if action == 'error' or not item:
                log_crawl(run_id, article['url'], 'error', error_message='upsert failed')
                skipped += 1
                continue

            if action == 'created':
                created += 1
            else:
                updated += 1
            item_id = item['id']
            print(f"  Item {action}: {item_id}")

            print(f"  Translating...")
            title_kr = translate_text(article['title'])
            summary_kr = translate_text(article.get('excerpt')[:500]) if article.get('excerpt') else ""

            upsert_translation(item_id, 'ko', title=title_kr, summary=summary_kr)
            print(f"  Translation saved (ko)")
            log_crawl(run_id, article['url'], 'success', item_id=item_id)

        except Exception as e:
            print(f"  Error: {e}", file=sys.stderr)
            log_crawl(run_id, article['url'], 'error', error_message=str(e))
            skipped += 1

        time.sleep(rate_limit_s)

    finish_crawl_run(run_id, 'completed',
                     items_found=items_found,
                     items_created=created,
                     items_updated=updated,
                     items_skipped=skipped)
    print(f"\nCrawl Run completed: {source_config['name']}")

if __name__ == "__main__":
    sources = [
        (YC_SOURCE, 2), 
        (VB_SOURCE, 2),
        (TC_SOURCE, 2),
        (SIFTED_SOURCE, 2),
        (TIA_SOURCE, 2),
        (GW_SOURCE, 2),
        (EU_SOURCE, 2),
        (YT_YC_SOURCE, 2),
    ]
    
    for config, limit in sources:
        try:
            run_source_crawl(config, max_items=limit)
        except Exception as e:
            print(f"Error crawling {config['name']}: {e}", file=sys.stderr)
