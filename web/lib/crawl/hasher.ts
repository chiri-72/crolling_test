import { createHash } from 'crypto'

export function makeHash(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl).digest('hex')
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    u.searchParams.delete('utm_source')
    u.searchParams.delete('utm_medium')
    u.searchParams.delete('utm_campaign')
    u.searchParams.delete('utm_content')
    u.searchParams.delete('utm_term')
    u.searchParams.sort()
    return u.toString()
  } catch {
    return url
  }
}
