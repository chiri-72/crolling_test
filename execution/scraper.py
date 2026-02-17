import os
import sys
import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime
from storage import save_crawled_data
from translator import translate_text # Future import
from dotenv import load_dotenv

load_dotenv()

# Layer 3: Deterministic Execution
# Target: Y Combinator Blog (List + Detail)

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

def parse_article_detail(url):
    html = fetch_page(url)
    if not html:
        return None
        
    soup = BeautifulSoup(html, 'html.parser')
    
    # Heuristic for YC Blog content
    # Usually in a 'prose' div or 'article' tag
    article_body = soup.find('div', class_=lambda x: x and 'prose' in x)
    if not article_body:
        article_body = soup.find('article')
        
    if article_body:
        # Get text, preserving some structure like paragraphs
        return article_body.get_text("\n\n", strip=True)
    return ""

def parse_yc_blog_list(html):
    soup = BeautifulSoup(html, 'html.parser')
    articles = []
    
    # Strategy 1: Recent Posts Grid
    # Container: div.flex.flex-col.overflow-hidden.rounded.shadow-sm
    for card in soup.find_all('div', class_='flex flex-col overflow-hidden rounded shadow-sm'):
        try:
            # Title & Link
            # Structure: <a href="..." class="mt-2 block"><p class="text-xl ...">Title</p>...</a>
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
            
            # Excerpt
            excerpt_tag = link_tag.find('p', class_='mt-3')
            excerpt = excerpt_tag.get_text(strip=True) if excerpt_tag else ""
            
            # Metadata (Author/Date)
            # Structure: <div class="mt-6 flex items-center"> ... <div class="ml-4"> ... 
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
                    # Try to parse date like "1/16/2026"
                    try:
                        dt = datetime.strptime(date_text, "%m/%d/%Y")
                        date = dt.strftime("%Y-%m-%d")
                    except:
                        pass # Keep default or raw string if needed

            articles.append({
                "title": title,
                "url": url,
                "author": author,
                "published_date": date,
                "excerpt": excerpt,
                "source_url": "https://www.ycombinator.com/blog",
                "crawled_at": datetime.now().isoformat()
            })
            
        except Exception as e:
            print(f"Error parsing item: {e}", file=sys.stderr)
            continue
            
    # Strategy 2: Featured/Latest Post (often different structure)
    # Looking for h2 as fallback from previous logic, but purely specific if grid fails
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
                        "source_url": "https://www.ycombinator.com/blog",
                        "crawled_at": datetime.now().isoformat()
                    })
            except:
                continue

    return articles

if __name__ == "__main__":
    target_url = "https://www.ycombinator.com/blog"
    print(f"Fetching list from {target_url}...")
    
    list_html = fetch_page(target_url)
    if list_html:
        articles = parse_yc_blog_list(list_html)
        print(f"Found {len(articles)} articles in list.")
        
        for article in articles[:3]: # Limit to 3 for testing
            print(f"Processing: {article['title']}")
            
            # 1. Fetch Detail
            content = parse_article_detail(article['url'])
            article['content_en'] = content
            
            # 2. Translate
            print(f"Translating: {article['title']}")
            article['title_kr'] = translate_text(article['title'])
            article['content_kr'] = translate_text(content)
            
            # 3. Save
            if save_crawled_data("yc_articles", article):
                print(f"Saved: {article['title']}")
            else:
                print(f"Failed to save: {article['title']}")
            
            print(f"Fetched content length: {len(content) if content else 0}")
            
            # Rate limiting prevention
            print("Waiting 5 seconds to avoid API rate limit...")
            import time
            time.sleep(5)

    else:
        sys.exit(1)
