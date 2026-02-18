#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const CHANNELS = [
  { name: "Y Combinator YouTube", url: "https://www.youtube.com/@ycombinator" },
  { name: "Sequoia Capital YouTube", url: "https://www.youtube.com/@SequoiaCapital" },
  { name: "a16z YouTube", url: "https://www.youtube.com/@a16z" },
  { name: "Bloomberg Tech YouTube", url: "https://www.youtube.com/bloombergtech" },
  { name: "CNBC Make It YouTube", url: "https://www.youtube.com/@CNBCMakeIt/videos" },
  { name: "Lex Fridman YouTube", url: "https://www.youtube.com/@lexfridman" },
  { name: "Ali Abdaal YouTube", url: "https://www.youtube.com/@AliAbdaal" },
  { name: "Lenny's Podcast YouTube", url: "https://www.youtube.com/@LennysPodcast" },
  { name: "Startups YouTube", url: "https://www.youtube.com/@startups/videos" },
];

function normalizeSeedUrl(url) {
  if (!url) return "";
  if (url.endsWith("/videos")) return url;
  if (/youtube\.com\/@/i.test(url)) return `${url.replace(/\/$/, "")}/videos`;
  return url;
}

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

async function main() {
  const cwd = process.cwd();
  loadEnvFromFile(path.join(cwd, ".env.local"));
  loadEnvFromFile(path.join(cwd, ".env"));
  loadEnvFromFile(path.join(cwd, "..", ".env"));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars");

  const supabase = createClient(url, key);
  const policy = {
    fetch_mode: "list_only",
    max_items_per_run: 20,
    recency_days: 14,
    min_title_len: 6,
    min_summary_len: 0,
    require_fields: ["title", "canonical_url"],
    block_keywords: ["livestream", "sponsored"],
    translate_only_if: { summary_char_limit: 600, title_char_limit: 140 },
    translation_budget: { max_tokens_per_run: 20000, max_tokens_per_item: 400 },
  };

  for (let i = 0; i < CHANNELS.length; i++) {
    const ch = CHANNELS[i];
    const seedUrl = normalizeSeedUrl(ch.url);
    const priority = 68 - i;

    const { data: existing, error: findError } = await supabase
      .from("sources")
      .select("id")
      .eq("name", ch.name)
      .maybeSingle();
    if (findError) throw findError;

    const payload = {
      name: ch.name,
      type: "youtube",
      seed_url: seedUrl,
      base_url: ch.url,
      is_active: true,
      priority,
      crawl_policy: policy,
    };

    if (existing?.id) {
      const { error } = await supabase.from("sources").update(payload).eq("id", existing.id);
      if (error) throw error;
      console.log(`[sources] updated: ${ch.name}`);
    } else {
      const { error } = await supabase.from("sources").insert(payload);
      if (error) throw error;
      console.log(`[sources] inserted: ${ch.name}`);
    }
  }

  console.log("[sources] done");
}

main().catch((err) => {
  console.error("[sources] failed:", err);
  process.exit(1);
});
