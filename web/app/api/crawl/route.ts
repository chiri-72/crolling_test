import { NextRequest, NextResponse } from 'next/server'
import { crawlDaily } from '@/lib/crawl'
import type { CrawlRequest } from '@/lib/crawl/types'

export const maxDuration = 300 // 5 min (Vercel Pro) or 60 (Hobby)

export async function POST(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const secret = process.env.CRAWL_SECRET

  if (!secret || token !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body: CrawlRequest = await request.json().catch(() => ({}))

    const result = await crawlDaily({
      dryRun: body.dryRun ?? false,
      sources: body.sources,
      maxItemsOverride: body.maxItemsOverride,
      translate: body.translate ?? true,
    })

    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Crawl error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
