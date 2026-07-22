// 共用資料管線工具：供 snapshot.mjs（每日最新）與 backfill.mjs（回補歷史）共用。
// 抽出避免兩支腳本重複維護排名/明細補抓/Gemini 題材/歷史寫入等邏輯。

import { promises as fs } from "node:fs";
import path from "node:path";

export const ROOT = process.cwd();
export const CACHE_DIR = path.join(ROOT, ".cache");
export const CACHE_FILE = path.join(CACHE_DIR, "polygon-tickers.json");
export const PUBLIC_DIR = path.join(ROOT, "public");
export const HISTORY_DIR = path.join(PUBLIC_DIR, "history");

export const TOP_N = 50; // 最終輸出的個股數
export const OVER_RANK = 90; // 過量排名上限（濾掉 ETF 後仍要湊滿 50）
export const META_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 名稱/市值/SIC 7 天重抓
export const THEME_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 題材標籤 30 天重抓

// Polygon ticker type 中屬於「基金/ETF」者一律排除（只保留個股與 ADR/普通股）。
export const FUND_TYPES = new Set(["ETF", "ETN", "ETV", "ETS", "FUND", "SP"]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const fmtDate = (d) => d.toISOString().slice(0, 10);

// 滑動視窗速率限制：每 60 秒最多 5 次（Polygon 免費方案）。
const callTimes = [];
async function rateSlot() {
  const now = Date.now();
  while (callTimes.length && now - callTimes[0] > 60_000) callTimes.shift();
  if (callTimes.length >= 5) await sleep(60_000 - (now - callTimes[0]) + 200);
  callTimes.push(Date.now());
}

export async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    await rateSlot();
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 403) return { resultsCount: 0, results: [] }; // 當日資料未開放
    // 401/429（限流）與 5xx（Polygon 伺服器暫時性錯誤）→ 退避重試。
    if ((res.status === 401 || res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(res.status >= 500 ? 5_000 * (attempt + 1) : 15_000);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url.replace(/apiKey=[^&]+/, "apiKey=***")}`);
  }
}

/** 從環境變數或 .env.local 讀取指定金鑰。 */
export async function readKey(name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    const raw = await fs.readFile(path.join(ROOT, ".env.local"), "utf8");
    const m = raw.match(new RegExp(`^${name}\\s*=\\s*(.+)\\s*$`, "m"));
    if (m) return m[1].trim();
  } catch {}
  return null;
}

/** 將全大寫的 SIC 字串轉為較易讀的標題大小寫（與 src/lib/format.ts formatSector 等價）。 */
export function formatSector(sector) {
  if (!sector || sector === "—") return "—";
  if (sector !== sector.toUpperCase()) return sector;
  return sector
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bAnd\b/g, "&");
}

export const grouped = (key, ds) =>
  `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${ds}?adjusted=true&apiKey=${key}`;
export const details = (key, t) =>
  `https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(t)}?apiKey=${key}`;

/** 載入既有 ticker 明細快取（重複執行可省去 API 呼叫）。 */
export async function loadCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

export async function saveCache(cache) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache), "utf8");
}

/**
 * 由某交易日的 grouped 結果排出成交值前段，逐檔補明細、濾掉 ETF/基金，湊滿 topN 檔個股。
 * @param results 該交易日 grouped results（每筆含 T/c/o/v/vw）。
 * @param prevMap Map<symbol, 前一交易日 grouped 列>，用於算漲跌幅；無則以當日 o→c 估。
 * @returns [{ b, dv, meta, changePercent, marketCap }]（已依成交值由大到小）。
 */
export async function pickTopStocks(results, prevMap, cache, polygonKey, opts = {}) {
  const topN = opts.topN ?? TOP_N;
  const overRank = opts.overRank ?? OVER_RANK;
  const log = opts.log ?? false;

  const ranked = results
    .map((b) => ({ b, dv: (b.vw && b.vw > 0 ? b.vw : b.c) * b.v }))
    .filter((r) => r.b.c > 0 && r.b.v > 0 && r.dv > 0)
    .sort((a, b) => b.dv - a.dv)
    .slice(0, overRank);

  const picked = [];
  for (const { b, dv } of ranked) {
    if (picked.length >= topN) break;
    const t = b.T;
    let meta = cache[t];
    if (!meta || Date.now() - meta.fetchedAt > META_TTL_MS) {
      try {
        const data = await getJson(details(polygonKey, t));
        const r = data.results ?? {};
        meta = {
          ...(cache[t] ?? {}),
          ticker: t,
          name: r.name ?? t,
          type: r.type ?? "",
          marketCap: r.market_cap ?? null,
          sharesOutstanding:
            r.share_class_shares_outstanding ?? r.weighted_shares_outstanding ?? null,
          sector: r.sic_description ?? null,
          fetchedAt: Date.now(),
        };
        cache[t] = meta;
        await saveCache(cache);
        if (log) console.log(`  補抓 ${t} → ${meta.name} (${meta.type})`);
      } catch (e) {
        meta = cache[t] ?? {
          ticker: t, name: t, type: "", marketCap: null, sharesOutstanding: null, sector: null,
        };
        if (log) console.warn(`  ${t} 明細補抓失敗：${e.message}`);
      }
    }
    if (FUND_TYPES.has((meta.type ?? "").toUpperCase())) {
      if (log) console.log(`  跳過 ETF/基金：${t} (${meta.type})`);
      continue;
    }
    const prevClose = prevMap.get(t)?.c;
    const changePercent =
      prevClose && prevClose > 0
        ? ((b.c - prevClose) / prevClose) * 100
        : ((b.c - b.o) / b.o) * 100;
    const marketCap =
      meta.sharesOutstanding && meta.sharesOutstanding > 0
        ? meta.sharesOutstanding * b.c
        : meta.marketCap ?? 0;
    picked.push({ b, dv, meta, changePercent, marketCap });
  }
  return picked;
}

// ───────────────────────── Gemini（題材標籤；結構化、無搜尋） ─────────────────────────

export const GEMINI_MODEL = "gemini-2.5-flash";

/** 呼叫 Gemini generateContent，對 429/500/503 退避重試，回傳解析後的回應物件。 */
export async function callGemini(apiKey, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    if ([429, 500, 503].includes(res.status) && attempt < 4) {
      const wait = 5_000 * (attempt + 1);
      console.warn(`  Gemini HTTP ${res.status}，${wait / 1000}s 後重試（第 ${attempt + 1} 次）…`);
      await sleep(wait);
      continue;
    }
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
}

/** 串接候選回應的所有 text part。 */
export function candidateText(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text || "").join("").trim();
}

/** 用 Gemini 分析每檔題材標籤 + 當日發動題材摘要。回傳 { themesByTicker, summary }。 */
export async function enrichWithGemini(stocks, apiKey) {
  const lines = stocks
    .map((s) => `${s.symbol} | ${s.name} | ${s.sector} | ${s.changePercent.toFixed(2)}%`)
    .join("\n");

  const prompt = `你是美股題材分析師。以下是某交易日「成交值前 50 名個股」（格式：代碼 | 名稱 | SIC產業 | 當日漲跌幅）：
${lines}

請完成兩件事，全部用繁體中文：
1. tickers：為每一檔指定「一個」精簡且具體的題材/族群標籤（例如：AI 晶片、記憶體、HBM、核電/SMR、量子運算、減肥藥 GLP-1、雲端軟體 SaaS、資安、比特幣/加密、太空、國防、電力基礎建設、電動車、生技製藥…）。同一族群的股票請用「完全一致」的標籤字串。避免過於籠統（不要只寫「科技」「半導體」）。
2. summary：找出當日「發動」的題材族群——以「上漲（漲跌幅為正）」的股票為主，依族群的強度（成員數與漲幅）由強到弱排序，最多 6 組。每組給 theme（題材名，需與 tickers 用詞一致）、reason（一句話說明該題材近期為何受資金關注，用你既有的知識）、symbols（屬於該族群且當日上漲的代碼陣列）。

只輸出 JSON。`;

  const schema = {
    type: "object",
    properties: {
      tickers: {
        type: "array",
        items: {
          type: "object",
          properties: { symbol: { type: "string" }, theme: { type: "string" } },
          required: ["symbol", "theme"],
        },
      },
      summary: {
        type: "array",
        items: {
          type: "object",
          properties: {
            theme: { type: "string" },
            reason: { type: "string" },
            symbols: { type: "array", items: { type: "string" } },
          },
          required: ["theme", "reason", "symbols"],
        },
      },
    },
    required: ["tickers", "summary"],
  };

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    // 關掉 gemini-2.5-flash 預設 thinking 並給足輸出上限：否則 thinking 會吃光 token 預算
    // → 回應為空/JSON 截斷 → 題材分析失敗退回 SIC（aiSource=none）。結構化輸出不需 thinking。
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0.3,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const data = await callGemini(apiKey, body);
  const text = candidateText(data);
  if (!text) throw new Error("Gemini 回應為空");
  const parsed = JSON.parse(text);

  const themesByTicker = new Map();
  for (const it of parsed.tickers ?? []) {
    if (it.symbol && it.theme) themesByTicker.set(it.symbol, it.theme);
  }
  return { themesByTicker, summary: parsed.summary ?? [] };
}

// ───────────────────────── 歷史快照存檔 ─────────────────────────

/**
 * 防呆：接地(grounded)AI 欄位偶發回空。若本次 out 的這些欄位為空、但同一交易日
 * 既有檔案有內容，沿用既有值，避免重跑（尤其 Polygon 閘門前的早班／Gemini 回空）
 * 把前一班的好資料洗成空白。只在既有檔為「同一交易日」時保護（換日 → 照常寫新資料）。
 * 就地修改並回傳 out。
 * @param out 本次要寫出的物件（含 asOf）。
 * @param existingPath 同交易日既有 <date>.json 的絕對路徑。
 */
export async function preserveGroundedAI(out, existingPath) {
  let existing;
  try {
    existing = JSON.parse(await fs.readFile(existingPath, "utf8"));
  } catch {
    return out; // 沒有既有檔或壞檔 → 照常寫
  }
  if (!existing || existing.asOf?.slice(0, 10) !== out.asOf?.slice(0, 10)) {
    return out; // 不同交易日（換日）→ 不保護，讓新資料寫入
  }

  const briefEmpty = (b) =>
    !b ||
    (!(b.highlights ?? "").trim() && !b.eventsPast?.length && !b.eventsUpcoming?.length);
  if (briefEmpty(out.marketBriefing) && !briefEmpty(existing.marketBriefing)) {
    out.marketBriefing = existing.marketBriefing;
    console.warn("⚠ 今日市場焦點本次為空 → 沿用既有同日焦點（避免洗空）");
  }

  if (!out.themeSummary?.length && existing.themeSummary?.length) {
    out.themeSummary = existing.themeSummary;
    console.warn("⚠ 發動題材本次為空 → 沿用既有同日題材（避免洗空）");
  }

  if (Array.isArray(out.newEntrants) && Array.isArray(existing.newEntrants)) {
    const oldReason = new Map(
      existing.newEntrants.filter((n) => n.reason).map((n) => [n.symbol, n.reason]),
    );
    let filled = 0;
    out.newEntrants = out.newEntrants.map((n) => {
      if (!n.reason && oldReason.has(n.symbol)) {
        filled++;
        return { ...n, reason: oldReason.get(n.symbol) };
      }
      return n;
    });
    if (filled) console.warn(`⚠ 新進榜 ${filled} 檔說明本次為空 → 沿用既有同日說明`);
  }

  return out;
}

/**
 * 寫入一份歷史快照（以交易日命名），並重建 index.json / trends.json。
 * @param out RankingsResponse 形狀的輸出物件（含 asOf）。
 */
export async function writeHistory(out) {
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  const date = out.asOf.slice(0, 10);
  await fs.writeFile(path.join(HISTORY_DIR, `${date}.json`), JSON.stringify(out, null, 2), "utf8");
  await rebuildHistoryMeta();
}

/**
 * 掃描 public/history/ 下所有 <date>.json，重建：
 *  - index.json：可選日期清單（新到舊）
 *  - trends.json：每檔個股跨日的名次/成交額/價格走勢（供前端走勢圖一次載入）
 */
export async function rebuildHistoryMeta() {
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  const files = (await fs.readdir(HISTORY_DIR))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort(); // 由舊到新

  const index = [];
  const symbols = {};
  const dates = [];

  for (const f of files) {
    const date = f.slice(0, 10);
    let data;
    try {
      data = JSON.parse(await fs.readFile(path.join(HISTORY_DIR, f), "utf8"));
    } catch {
      continue;
    }
    const rows = data.rows ?? [];
    dates.push(date);
    index.push({
      date,
      asOf: data.asOf,
      generatedAt: data.generatedAt ?? null,
      count: rows.length,
    });
    // rows 已依成交值由大到小排序 → 索引即成交值名次。
    rows.forEach((r, i) => {
      const sym = r.symbol;
      if (!symbols[sym]) symbols[sym] = { name: r.name, points: [] };
      symbols[sym].name = r.name;
      symbols[sym].points.push({
        d: date,
        rank: i + 1,
        dv: r.dollarVolume,
        price: r.price,
        chg: r.changePercent,
        streak: r.streak,
      });
    });
  }

  index.reverse(); // 新到舊
  await fs.writeFile(path.join(HISTORY_DIR, "index.json"), JSON.stringify(index), "utf8");
  await fs.writeFile(
    path.join(HISTORY_DIR, "trends.json"),
    JSON.stringify({ dates, symbols }),
    "utf8",
  );
  return { dates, count: files.length };
}
