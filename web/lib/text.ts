export function decodeHtmlEntities(input: string): string {
  if (!input) return ""

  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  }

  return input
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _
    })
    .replace(/&([a-zA-Z]+);/g, (full, key: string) => named[key] ?? full)
}

function maybeRepairMojibake(input: string): string {
  // Typical UTF-8 read as latin1 patterns.
  if (!/[Ãâ][\x80-\xBF]?/.test(input)) return input
  try {
    const repaired = Buffer.from(input, "latin1").toString("utf8")
    if (repaired.includes("\uFFFD")) return input
    return repaired
  } catch {
    return input
  }
}

export function normalizeSummaryText(input: string | null | undefined): string {
  if (!input) return ""

  const withLinks = input.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis,
    (_full, href: string, text: string) => {
      const label = text.replace(/<[^>]*>/g, "").trim()
      return label ? `${label} (${href})` : href
    },
  )

  const noTags = withLinks.replace(/<[^>]+>/g, " ")
  const decoded = decodeHtmlEntities(noTags)
  const repaired = maybeRepairMojibake(decoded)

  return repaired
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function normalizeTitle(input: string | null | undefined): string {
  if (!input) return ""
  return normalizeSummaryText(input).replace(/\n+/g, " ").trim()
}

export function extractUrls(input: string): string[] {
  const matches = input.match(/https?:\/\/[^\s)]+[^\s.,!?;:)]/g) ?? []
  return Array.from(new Set(matches))
}

export function sanitizeSummaryForDisplay(input: string | null | undefined): string {
  const normalized = normalizeSummaryText(input)
  if (!normalized) return ""

  const withoutLabeledMeta = normalized
    .replace(/Article URL:\s*https?:\/\/\S+/gi, " ")
    .replace(/Comments URL:\s*https?:\/\/\S+/gi, " ")
    .replace(/Points:\s*\d+/gi, " ")
    .replace(/#\s*Comments:\s*\d+/gi, " ")

  const withoutUrls = withoutLabeledMeta.replace(/https?:\/\/\S+/g, " ")

  return withoutUrls
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function isMeaningfulSummary(input: string | null | undefined): boolean {
  const s = sanitizeSummaryForDisplay(input)
  if (!s) return false
  const alphaNumCount = (s.match(/[A-Za-z0-9가-힣]/g) ?? []).length
  return alphaNumCount >= 24
}
