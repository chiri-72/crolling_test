#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const SYSTEM_PROMPT = `You are a professional IT/startup translator.
Translate the given titles and summaries into natural Korean.
Maintain technical terms (SaaS, IPO, AI, API, YC, etc.) as-is.
Output ONLY valid JSON: {"translations":[{"idx":0,"title":"...","summary":"..."},...]}`;

function loadEnvFromFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseArgs() {
  const dryRun = process.argv.includes("--dry-run");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const batchArg = process.argv.find((a) => a.startsWith("--batch="));
  const modelArg = process.argv.find((a) => a.startsWith("--model="));
  const limit = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : 200;
  const batchSize = batchArg ? Number.parseInt(batchArg.split("=")[1], 10) : 10;
  const model = modelArg ? modelArg.split("=")[1] : "gemini-2.0-flash";
  return {
    dryRun,
    limit: Number.isFinite(limit) ? limit : 200,
    batchSize: Number.isFinite(batchSize) ? batchSize : 10,
    model,
  };
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function collectPendingItems(supabase, limit) {
  const pending = [];
  let offset = 0;
  const scanBatchSize = 200;
  const maxScanRows = 5000;
  let scanned = 0;

  while (pending.length < limit && scanned < maxScanRows) {
    const { data: items, error: itemsError } = await supabase
      .from("items")
      .select("id, title, summary")
      .order("created_at", { ascending: true })
      .range(offset, offset + scanBatchSize - 1);

    if (itemsError) throw itemsError;
    if (!items || items.length === 0) break;

    scanned += items.length;
    offset += items.length;
    const ids = items.map((it) => it.id);

    const { data: translations, error: trError } = await supabase
      .from("item_translations")
      .select("item_id, title_translated, summary_translated")
      .eq("lang", "ko")
      .in("item_id", ids);

    if (trError) throw trError;
    const trById = new Map((translations ?? []).map((tr) => [tr.item_id, tr]));

    for (const item of items) {
      const tr = trById.get(item.id);
      if (hasText(tr?.title_translated) || hasText(tr?.summary_translated)) continue;
      pending.push({
        item_id: item.id,
        title: item.title ?? "",
        summary: item.summary ?? "",
      });
      if (pending.length >= limit) break;
    }
  }

  return { pending, scanned };
}

async function translateBatch(batch, { apiKey, model }) {
  const payload = JSON.stringify(
    batch.map((j, idx) => ({
      idx,
      title: String(j.title ?? "").slice(0, 140),
      summary: String(j.summary ?? "").slice(0, 600),
    })),
  );

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 400 * batch.length,
          responseMimeType: "application/json",
        },
        contents: [
          {
            role: "user",
            parts: [{ text: `${SYSTEM_PROMPT}\n\nInput JSON:\n${payload}` }],
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  const resp = await response.json();
  const usage = Number(resp?.usageMetadata?.totalTokenCount ?? 0);
  const content = resp?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const jsonStr = String(content).replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(jsonStr);
  const translations = Array.isArray(parsed?.translations) ? parsed.translations : [];

  return { translations, usage };
}

async function main() {
  const cwd = process.cwd();
  loadEnvFromFile(path.join(cwd, ".env.local"));
  loadEnvFromFile(path.join(cwd, ".env"));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const { dryRun, limit, batchSize, model } = parseArgs();
  const supabase = createClient(url, key);

  const { pending, scanned } = await collectPendingItems(supabase, limit);
  console.log(`[backfill:translations] scanned=${scanned} pending=${pending.length} dryRun=${dryRun}`);

  let translated = 0;
  let failed = 0;
  let totalTokens = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    try {
      const { translations, usage } = await translateBatch(batch, { apiKey, model });
      totalTokens += usage;

      for (let k = 0; k < batch.length; k++) {
        const t = translations.find((tr) => tr.idx === k) ?? translations[k];
        const titleTranslated = hasText(t?.title) ? String(t.title).trim() : "";
        const summaryTranslated = hasText(t?.summary) ? String(t.summary).trim() : "";
        if (!titleTranslated && !summaryTranslated) {
          failed++;
          continue;
        }

        translated++;
        if (dryRun) continue;

        const { error: upsertError } = await supabase
          .from("item_translations")
          .upsert({
            item_id: batch[k].item_id,
            lang: "ko",
            title_translated: titleTranslated || null,
            summary_translated: summaryTranslated || null,
            provider: "gemini",
            model,
            tokens_used: Math.max(1, Math.round(usage / Math.max(1, batch.length))),
          }, { onConflict: "item_id,lang" });

        if (upsertError) throw upsertError;
      }
    } catch (err) {
      failed += batch.length;
      console.error("[backfill:translations] batch failed:", err);
    }
  }

  console.log(
    `[backfill:translations] done translated=${translated} failed=${failed} tokens=${totalTokens}`,
  );
}

main().catch((err) => {
  console.error("[backfill:translations] failed:", err);
  process.exit(1);
});
