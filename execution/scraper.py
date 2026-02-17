import os
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

load_dotenv()

# Layer 3: Deterministic Execution
# Target: Y Combinator Blog (List + Detail)
# Schema: V2 (sources → items → item_translations + crawl_runs/logs)

# ── YC Blog Source Config ────────────────────────────────────

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


# ── HTTP Fetch ───────────────────────────────────────────────

def fetch_page(url):
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36'
        }
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        return response.text
    except Exception as e:
        print(f"Error fetching {url}: {e}", file=sys.stderr)
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


# ── Main Pipeline ────────────────────────────────────────────

def run_yc_crawl(max_items=3):
    """YC Blog 크롤링 전체 파이프라인 (V2)"""

    # 1. Source 등록/조회
    source = get_or_create_source(**YC_SOURCE)
    if not source:
        print("Failed to get/create source.", file=sys.stderr)
        sys.exit(1)
    source_id = source['id']
    print(f"Source: {source['name']} ({source_id})")

    # 2. Crawl Run 시작
    run = start_crawl_run(source_id)
    if not run:
        print("Failed to start crawl run.", file=sys.stderr)
        sys.exit(1)
    run_id = run['id']
    print(f"Crawl Run started: {run_id}")

    # 3. Fetch list page
    target_url = YC_SOURCE['base_url']
    print(f"Fetching list from {target_url}...")
    list_html = fetch_page(target_url)
    if not list_html:
        finish_crawl_run(run_id, 'failed', error_message='Failed to fetch list page')
        sys.exit(1)

    articles = parse_yc_blog_list(list_html)
    items_found = len(articles)
    print(f"Found {items_found} articles.")

    created = updated = skipped = 0
    rate_limit_s = YC_SOURCE['crawl_policy'].get('rate_limit_ms', 5000) / 1000

    # 4. Process each article
    for article in articles[:max_items]:
        print(f"\nProcessing: {article['title']}")

        try:
            # 4a. Fetch detail
            content = parse_article_detail(article['url'])

            # 4b. Upsert item
            item_data = {
                'title': article['title'],
                'summary': article.get('excerpt'),
                'author': article.get('author'),
                'published_at': article.get('published_date'),
                'canonical_url': article['url'],
                'content_text': content,
                'language': 'en',
                'source_item_id': article['url'].rstrip('/').split('/')[-1],
                'raw': {
                    'source_url': YC_SOURCE['base_url'],
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

            # 4c. Translate & save translation
            print(f"  Translating...")
            title_kr = translate_text(article['title'])
            content_kr = translate_text(content) if content else ""

            upsert_translation(item_id, 'ko', title=title_kr, content=content_kr)
            print(f"  Translation saved (ko)")

            # 4d. Log success
            log_crawl(run_id, article['url'], 'success', item_id=item_id)

        except Exception as e:
            print(f"  Error: {e}", file=sys.stderr)
            log_crawl(run_id, article['url'], 'error', error_message=str(e))
            skipped += 1

        # Rate limiting
        print(f"  Waiting {rate_limit_s}s...")
        time.sleep(rate_limit_s)

    # 5. Finish crawl run
    finish_crawl_run(run_id, 'completed',
                     items_found=items_found,
                     items_created=created,
                     items_updated=updated,
                     items_skipped=skipped)
    print(f"\nCrawl Run completed: found={items_found} created={created} updated={updated} skipped={skipped}")


if __name__ == "__main__":
    run_yc_crawl(max_items=3)
