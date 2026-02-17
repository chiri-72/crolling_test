# V2 운영 체크리스트

## 1. 스키마 배포 순서

```
1) Supabase SQL Editor → schema_v2.sql 실행 (9개 테이블 생성)
2) Supabase SQL Editor → migrate_v2.sql 실행 (기존 3건 마이그레이션)
3) 검증 쿼리로 데이터 확인
4) (선택) yc_articles → _yc_articles_backup 리네임
```

## 2. 중복 방지 (멱등성)

| 레벨 | 메커니즘 | 설명 |
|------|----------|------|
| items | `hash` unique index | `sha256(canonical_url)` 기반, upsert on conflict |
| item_translations | `(item_id, lang)` unique | 동일 아이템+언어 조합은 1건만 |
| sources | `slug` unique | 소스 중복 등록 방지 |

## 3. 재시도 전략

- **네트워크 에러**: `fetch_page()` 실패 시 crawl_logs에 error 기록, 다음 아이템으로 진행
- **번역 에러 (429)**: translator.py가 원문 반환 (graceful fallback)
- **DB 에러**: upsert 실패 시 crawl_logs에 error 기록, skipped 카운트 증가

## 4. 레이트 리밋

- `crawl_policy.rate_limit_ms` (기본 5000ms) → 아이템 간 대기
- Gemini API: 무료 티어 15 RPM → 번역 2건/아이템 기준 최대 7아이템/분
- 대량 크롤링 시 `max_items_per_run`으로 1회 실행 제한

## 5. 에러 로그 모니터링

```sql
-- 최근 실패한 크롤링 런
select * from crawl_runs where status = 'failed' order by started_at desc limit 10;

-- 아이템별 에러 로그
select cl.url, cl.error_message, cl.created_at
from crawl_logs cl
where cl.status = 'error'
order by cl.created_at desc limit 20;

-- 번역 누락 아이템 (items에는 있지만 translation이 없는 것)
select i.title, i.canonical_url
from items i
left join item_translations t on t.item_id = i.id and t.lang = 'ko'
where t.id is null;
```

## 6. Upsert 패턴 (새 소스 추가 시)

```python
# 1) 소스 등록
source = get_or_create_source(
    slug='techcrunch',
    name='TechCrunch',
    source_type='rss',
    base_url='https://techcrunch.com/feed/',
    crawl_policy={'rate_limit_ms': 3000}
)

# 2) 크롤링 런 시작
run = start_crawl_run(source['id'])

# 3) 아이템 upsert (hash 기반 멱등)
item, action = upsert_item(source['id'], {
    'title': '...',
    'canonical_url': 'https://techcrunch.com/2026/...',
    'content_text': '...',
    'language': 'en',
    'raw': {'feed_entry': {...}},
})

# 4) 번역 upsert
upsert_translation(item['id'], 'ko', title='...', content='...')

# 5) 로그 기록
log_crawl(run['id'], url, 'success', item_id=item['id'])

# 6) 런 종료
finish_crawl_run(run['id'], 'completed', items_found=N, items_created=M)
```

## 7. 필수 인덱스 요약

| 인덱스 | 용도 |
|--------|------|
| `idx_items_hash` (unique) | 중복 방지, upsert 충돌 해소 |
| `idx_items_source_id` | 소스별 필터링 |
| `idx_items_published_at` | 시간순 정렬/조회 |
| `idx_items_canonical_url` | URL 기반 조회 |
| `idx_items_language` | 언어별 필터 |
| `idx_items_source_published` | 소스+시간 복합 조회 |
| `idx_item_translations_item_id` | 번역 조인 |
| `idx_item_tags_tag_id` | 태그 조인 |
| `idx_item_entities_entity_id` | 엔티티 조인 |
| `idx_crawl_runs_source_id` | 소스별 런 조회 |
| `idx_crawl_runs_started_at` | 최근 런 조회 |
| `idx_crawl_logs_run_id` | 런별 로그 조회 |
