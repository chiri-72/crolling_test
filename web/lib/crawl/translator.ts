import type { TranslationJob, TranslationResult } from './types'
import { isMeaningfulSummary, normalizeSummaryText, normalizeTitle, sanitizeSummaryForDisplay } from '@/lib/text'

const SYSTEM_PROMPT = `You are a professional IT/startup translator.
Translate the given titles and summaries into natural Korean.
Maintain technical terms (SaaS, IPO, AI, API, YC, etc.) as-is.
Output ONLY valid JSON: {"translations":[{"idx":0,"title":"...","summary":"..."},...]}`

interface TranslateOptions {
  maxTokensPerRun: number
  maxTokensPerItem: number
  batchSize: number
  model: string
}

const DEFAULT_OPTS: TranslateOptions = {
  maxTokensPerRun: 20000,
  maxTokensPerItem: 400,
  batchSize: 10,
  model: 'gemini-2.0-flash',
}

export async function translateBatch(
  jobs: TranslationJob[],
  opts: Partial<TranslateOptions> = {},
): Promise<{
  results: TranslationResult[]
  totalTokens: number
  skipped: number
  failed: number
}> {
  const o = { ...DEFAULT_OPTS, ...opts }
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY')
  }
  const results: TranslationResult[] = []
  let totalTokens = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < jobs.length; i += o.batchSize) {
    // Budget guard
    if (totalTokens >= o.maxTokensPerRun) {
      skipped += jobs.length - i
      break
    }

    const batch = jobs.slice(i, i + o.batchSize)

    const payload = JSON.stringify(
      batch.map((j, idx) => ({
        idx,
        title: j.title.slice(0, 140),
        summary: (j.summary ?? '').slice(0, 600),
      })),
    )

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${o.model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: o.maxTokensPerItem * batch.length,
              responseMimeType: 'application/json',
            },
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: `${SYSTEM_PROMPT}\n\nInput JSON:\n${payload}`,
                  },
                ],
              },
            ],
          }),
        },
      )

      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(`Gemini HTTP ${response.status}: ${errorBody.slice(0, 500)}`)
      }

      const resp = await response.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>
          }
        }>
        usageMetadata?: {
          totalTokenCount?: number
        }
      }

      const usage = resp.usageMetadata?.totalTokenCount ?? 0
      totalTokens += usage

      let translations: Array<{ idx: number; title: string; summary: string }> = []
      try {
        const content = resp.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
        const jsonStr = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
        const parsed = JSON.parse(jsonStr)
        translations = parsed.translations ?? []
      } catch {
        failed += batch.length
        continue
      }

      for (let k = 0; k < batch.length; k++) {
        const t = translations.find((tr) => tr.idx === k) ?? translations[k]
        if (t) {
          const translatedSummary = sanitizeSummaryForDisplay(normalizeSummaryText(t.summary ?? ''))
          results.push({
            item_id: batch[k].item_id,
            title_translated: normalizeTitle(t.title ?? ''),
            summary_translated: isMeaningfulSummary(translatedSummary) ? translatedSummary : '',
            tokens_used: Math.round(usage / batch.length),
          })
        } else {
          failed++
        }
      }
    } catch (err) {
      failed += batch.length
      console.error('Translation batch error:', err)
    }
  }

  return { results, totalTokens, skipped, failed }
}
