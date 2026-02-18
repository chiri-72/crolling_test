#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

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

function decodeHtmlEntities(input) {
  if (!input) return "";
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return input
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&([a-zA-Z]+);/g, (full, key) => named[key] ?? full);
}

function normalizeSummaryText(input) {
  if (!input) return "";
  const withLinks = input.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis,
    (_full, href, text) => {
      const label = text.replace(/<[^>]*>/g, "").trim();
      return label ? `${label} (${href})` : href;
    },
  );
  const noTags = withLinks.replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(noTags)
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeSummaryForDisplay(input) {
  const normalized = normalizeSummaryText(input);
  if (!normalized) return "";
  const withoutLabeledMeta = normalized
    .replace(/Article URL:\s*https?:\/\/\S+/gi, " ")
    .replace(/Comments URL:\s*https?:\/\/\S+/gi, " ")
    .replace(/Points:\s*\d+/gi, " ")
    .replace(/#\s*Comments:\s*\d+/gi, " ");
  const withoutUrls = withoutLabeledMeta.replace(/https?:\/\/\S+/g, " ");
  return withoutUrls.replace(/[ ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function isMeaningfulSummary(input) {
  const s = sanitizeSummaryForDisplay(input);
  if (!s) return false;
  const alphaNumCount = (s.match(/[A-Za-z0-9가-힣]/g) ?? []).length;
  return alphaNumCount >= 24;
}

function cleanedSummary(input) {
  const cleaned = sanitizeSummaryForDisplay(input);
  return isMeaningfulSummary(cleaned) ? cleaned : null;
}

function parseArgs() {
  const dryRun = process.argv.includes("--dry-run");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const batchArg = process.argv.find((a) => a.startsWith("--batch="));
  const limit = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : null;
  const batchSize = batchArg ? Number.parseInt(batchArg.split("=")[1], 10) : 200;
  return { dryRun, limit, batchSize: Number.isFinite(batchSize) ? batchSize : 200 };
}

async function main() {
  const cwd = process.cwd();
  loadEnvFromFile(path.join(cwd, ".env.local"));
  loadEnvFromFile(path.join(cwd, ".env"));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const { dryRun, limit, batchSize } = parseArgs();
  const supabase = createClient(url, key);

  let offset = 0;
  let scanned = 0;
  let changed = 0;
  let emptied = 0;

  console.log(`[backfill] start dryRun=${dryRun} batch=${batchSize} limit=${limit ?? "none"}`);

  while (true) {
    const end = offset + batchSize - 1;
    const { data, error } = await supabase
      .from("items")
      .select("id, summary")
      .order("created_at", { ascending: true })
      .range(offset, end);

    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (limit != null && scanned >= limit) break;
      scanned++;
      const before = row.summary ?? null;
      const after = cleanedSummary(before);
      if (before === after) continue;

      changed++;
      if (after == null) emptied++;

      if (!dryRun) {
        const { error: updateError } = await supabase
          .from("items")
          .update({ summary: after })
          .eq("id", row.id);
        if (updateError) throw updateError;
      }
    }

    console.log(`[backfill] scanned=${scanned} changed=${changed} emptied=${emptied}`);
    if (limit != null && scanned >= limit) break;
    offset += data.length;
  }

  console.log(`[backfill] done scanned=${scanned} changed=${changed} emptied=${emptied}`);
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
