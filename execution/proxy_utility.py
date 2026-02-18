import os
import random
from dotenv import load_dotenv

load_dotenv()

# PROXY_LIST: comma separated list of proxy URLs
PROXY_LIST = os.getenv("PROXY_LIST", "").split(",")
SCRAPER_API_KEY = os.getenv("SCRAPER_API_KEY")

def get_proxy():
    """Select a random proxy from the environment variable."""
    valid_proxies = [p.strip() for p in PROXY_LIST if p.strip()]
    if not valid_proxies:
        return None
    
    proxy_url = random.choice(valid_proxies)
    return {
        "http": proxy_url,
        "https": proxy_url
    }

def get_scraper_api_url(url):
    """Transform URL for ScraperAPI usage."""
    if not SCRAPER_API_KEY:
        return url
    return f"http://api.scraperapi.com?api_key={SCRAPER_API_KEY}&url={url}"

def get_request_params(url):
    """Return dictionary with url, proxies and timeout for requests."""
    # Skip proxy for YouTube RSS as it often causes 404/issues with ScraperAPI
    if "youtube.com/feeds" in url:
        return {
            "url": url,
            "proxies": None,
            "timeout": 15
        }
        
    params = {
        "url": url,
        "proxies": get_proxy(),
        "timeout": 15
    }
    
    if SCRAPER_API_KEY:
        params["url"] = get_scraper_api_url(url)
        params["proxies"] = None 
        
    return params

if __name__ == "__main__":
    test_url = "https://httpbin.org/ip"
    print(f"Testing with: {test_url}")
    print(f"Params: {get_request_params(test_url)}")
