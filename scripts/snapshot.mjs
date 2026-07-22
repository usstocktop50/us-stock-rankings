// 產生靜態網站的資料快照：抓取最新交易日全美股成交值前 50 名「個股」（排除 ETF），
// 補上名稱/市值/SIC，並用 Gemini 分析題材/族群；標示新進榜與排名躍升。
// 寫入 public/rankings.json，並另存一份歷史快照 public/history/<交易日>.json（重建 index/trends）。
// 供 GitHub Action 每日收盤後執行，或本機手動執行。
//
// 用法： node scripts/snapshot.mjs
// 環境變數 / .env.local：POLYGON_API_KEY（必要）、GEMINI_API_KEY（選用，缺少則題材退回 SIC）

import {
  sleep,
  fmtDate,
  getJson,
  readKey,
  formatSector,
  grouped,
  loadCache,
  saveCache,
  pickTopStocks,
  callGemini,
  candidateText,
  enrichWithGemini,
  writeHistory,
  preserveGroundedAI,
  THEME_TTL_MS,
  ROOT,
  HISTORY_DIR,
} from "./lib/core.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";

const OUT_FILE = path.join(ROOT, "public", "rankings.json");

// 前一份快照（線上）來源，用於計算 isNew / rankChange；可用 env 覆寫。
const PREV_RANKINGS_URL =
  process.env.PREV_RANKINGS_URL ||
  "https://usstocktop50.github.io/us-stock-rankings/rankings.json";

/** 從昨天往回找最近兩個有資料的交易日（最新用於排行，前一日用於漲跌幅）。 */
async function findTradingDays(key) {
  const days = [];
  const cursor = new Date();
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  for (let i = 0; i < 14 && days.length < 2; i++) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const ds = fmtDate(cursor);
      const data = await getJson(grouped(key, ds));
      if ((data.resultsCount ?? 0) > 0) days.push({ date: ds, results: data.results });
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return days;
}

/**
 * 取「前一交易日」基準（優先，且最穩）：讀 public/history 下日期 < latestDate 的最新一檔。
 * 用真正的前一交易日來算 streak/isNew/rankChange，可避免「同日重跑/重部署」把 streak 壓回線上舊值。
 * 回傳與 fetchPrev 相同形狀；無歷史則回 null（呼叫端退回 fetchPrev）。
 */
async function readPrevFromHistory(latestDate) {
  try {
    const dates = (await fs.readdir(HISTORY_DIR))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .filter((d) => d < latestDate)
      .sort();
    const prevDate = dates[dates.length - 1];
    if (!prevDate) return null;
    const data = JSON.parse(await fs.readFile(path.join(HISTORY_DIR, `${prevDate}.json`), "utf8"));
    const ranks = new Map();
    const rows = new Map();
    (data.rows ?? []).forEach((r, i) => {
      ranks.set(r.symbol, i + 1);
      rows.set(r.symbol, r);
    });
    return { ranks, rows, date: prevDate };
  } catch {
    return null;
  }
}

/** 取得線上前一份快照：symbol→名次(1-based)、symbol→該列資料、資料交易日。 */
async function fetchPrev() {
  try {
    const res = await fetch(PREV_RANKINGS_URL);
    if (!res.ok) return null;
    const data = await res.json();
    const ranks = new Map();
    const rows = new Map();
    (data.rows ?? []).forEach((r, i) => {
      ranks.set(r.symbol, i + 1);
      rows.set(r.symbol, r);
    });
    const date = typeof data.asOf === "string" ? data.asOf.slice(0, 10) : null;
    return { ranks, rows, date };
  } catch {
    return null;
  }
}

/**
 * 用 Gemini + Google 搜尋，為「新進榜」個股說明近期催化劑（發生了什麼）。
 * 回傳 Map<symbol, reason>。grounding 與結構化輸出不相容，故用容錯 JSON 解析。
 */
async function explainNewEntrants(newStocks, apiKey) {
  const lines = newStocks
    .map((s) => `${s.symbol} | ${s.name} | ${s.theme} | ${s.changePercent.toFixed(2)}%`)
    .join("\n");
  const prompt = `以下是今天「首次進入美股成交值前 50」的個股（代碼 | 名稱 | 題材 | 當日漲跌幅）：
${lines}

請用 Google 搜尋它們「最近幾天」的相關新聞，逐檔說明：這檔股票為何會突然放量、衝進成交值前 50？請指出「具體催化劑」（例如財報/財測、新產品或大訂單、分析師調升、併購、法說會、題材輪動、突發事件等）。每檔「一句話、20 字內」、繁體中文、務實具體；若查無明確消息，請說「近期無明確個股消息，可能受族群輪動帶動」。
只輸出 JSON 陣列，格式：[{"symbol":"代碼","reason":"一句話原因"}]，不要任何其他文字或 markdown。`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    // 關 thinking、拉高上限，避免 grounding 回應截斷 JSON（新進榜檔數多時尤其容易爆 token）。
    generationConfig: { temperature: 0.4, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
  };
  const data = await callGemini(apiKey, body);
  const text = candidateText(data);
  const map = new Map();
  for (const it of parseJsonObjects(text)) {
    if (it.symbol && it.reason) map.set(it.symbol, it.reason);
  }
  if (map.size === 0) throw new Error("新進榜回應無可解析的 JSON");
  return map;
}

/**
 * 從（可能被截斷的）grounded 回應文字抽出 JSON 物件陣列。
 * 先試整段陣列解析；失敗則逐一抽出完整的 {…} 物件（容忍尾端被截斷）。
 */
function parseJsonObjects(text) {
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s >= 0 && e > s) {
    try {
      const arr = JSON.parse(text.slice(s, e + 1));
      if (Array.isArray(arr)) return arr;
    } catch {}
  }
  const out = [];
  for (const m of text.match(/\{[^{}]*\}/g) ?? []) {
    try {
      out.push(JSON.parse(m));
    } catch {}
  }
  return out;
}

/**
 * 用 Gemini + Google 搜尋產生「今日市場焦點」：
 * 聚焦成交值最高的榜上熱門股/族群為何爆量（highlights），並列出
 * 當日已發生（eventsPast）與即將到來（eventsUpcoming）的重大事件。
 * grounding 與結構化輸出不相容，故用容錯 JSON 解析。失敗則丟例外（呼叫端後備為 null）。
 */
async function marketBriefing(topStocks, themeSummary, apiKey, tradingDate) {
  const stockLines = topStocks
    .map(
      (s) =>
        `${s.symbol} | ${s.name} | ${s.theme} | ${s.changePercent.toFixed(2)}% | $${(
          s.dollarVolume / 1e9
        ).toFixed(1)}B`,
    )
    .join("\n");
  const themeLines = themeSummary.length
    ? themeSummary.map((t) => `${t.theme}（${t.symbols.join("、")}）`).join("\n")
    : "（無）";

  const prompt = `今天分析的是美股 ${tradingDate}（前一交易日收盤）的資料。以下是當日「成交值前段」中成交金額最高的個股（代碼 | 名稱 | 題材 | 漲跌幅 | 成交金額）：
${stockLines}

當日發動的題材族群：
${themeLines}

請用 Google 搜尋「最近幾天」的美股新聞，完成三件事，全部繁體中文、務實具體，並「聚焦上面這些榜上熱門股與族群」：
1. highlights：用 2–4 句話總結「本日成交重點」——資金為何集中在這些個股/族群、誰帶動了成交量、市場在交易什麼故事。
2. eventsPast：當日（或最近一兩天）已發生、且與這些個股/族群相關的重大事件（財報、財測、Fed、經濟數據、併購、重大新聞等），每筆 title（簡短標題）+ detail（一句說明）。最多 5 筆；若無明確消息給空陣列。
3. eventsUpcoming：未來幾天值得注意的重要事件（重要財報日、Fed 會議、CPI/就業數據、產品發表等），每筆 date（如 "6/10" 或 "本週四"）+ title + detail。最多 5 筆；若無則給空陣列。

只輸出 JSON，格式：
{"highlights":"...","eventsPast":[{"title":"...","detail":"..."}],"eventsUpcoming":[{"date":"...","title":"...","detail":"..."}]}
不要任何其他文字或 markdown。`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    // 關掉 thinking 並拉高輸出上限，避免 grounding 回應把 JSON 寫到一半就被截斷。
    generationConfig: { temperature: 0.4, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
  };
  const data = await callGemini(apiKey, body);
  const text = candidateText(data);
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("市場焦點回應無 JSON 物件");
  const parsed = JSON.parse(text.slice(s, e + 1));
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  return {
    highlights: str(parsed.highlights),
    eventsPast: (Array.isArray(parsed.eventsPast) ? parsed.eventsPast : [])
      .filter((x) => x && (x.title || x.detail))
      .slice(0, 5)
      .map((x) => ({ title: str(x.title), detail: str(x.detail) })),
    eventsUpcoming: (Array.isArray(parsed.eventsUpcoming) ? parsed.eventsUpcoming : [])
      .filter((x) => x && (x.title || x.detail))
      .slice(0, 5)
      .map((x) => ({ date: str(x.date), title: str(x.title), detail: str(x.detail) })),
  };
}

/** 預期「最近一個已收盤的美股交易日」(UTC)：昨天起往回第一個工作日（不計假日）。 */
function mostRecentExpectedTradingDate() {
  const c = new Date();
  c.setUTCDate(c.getUTCDate() - 1);
  while (c.getUTCDay() === 0 || c.getUTCDay() === 6) c.setUTCDate(c.getUTCDate() - 1);
  return fmtDate(c);
}

// 自檢重試：若抓到的最新交易日落後預期（Polygon 尚未公布），等候後重試。
const STALE_RETRY_ATTEMPTS = 4;
const STALE_RETRY_WAIT_MS = 20 * 60_000; // 20 分鐘

/** 取交易日資料；若資料落後預期則延遲重試（自檢資料是否為最新）。 */
async function getTradingDaysFresh(key) {
  const expected = mostRecentExpectedTradingDate();
  let days = [];
  for (let attempt = 0; attempt <= STALE_RETRY_ATTEMPTS; attempt++) {
    days = await findTradingDays(key);
    const latest = days[0]?.date;
    if (!latest) {
      throw new Error("找不到近期可用的交易日資料");
    }
    if (latest >= expected || attempt === STALE_RETRY_ATTEMPTS) {
      if (latest < expected) {
        console.warn(`已重試 ${attempt} 次，最新仍為 ${latest}（預期 ${expected}）；可能為假日或 Polygon 延遲，先用現有資料。`);
      }
      return days;
    }
    console.log(
      `最新可用 ${latest} 落後預期 ${expected}（資料可能尚未公布），${STALE_RETRY_WAIT_MS / 60000} 分鐘後重試（${attempt + 1}/${STALE_RETRY_ATTEMPTS}）…`,
    );
    await sleep(STALE_RETRY_WAIT_MS);
  }
  return days;
}

async function main() {
  const polygonKey = await readKey("POLYGON_API_KEY");
  if (!polygonKey) {
    console.error("未找到 POLYGON_API_KEY（本機請設於 .env.local；CI 請設為 Secret）");
    process.exit(1);
  }
  const geminiKey = await readKey("GEMINI_API_KEY");

  console.log("尋找最近交易日並抓取 grouped 資料（含自檢重試）…");
  const days = await getTradingDaysFresh(polygonKey);
  const latest = days[0];
  const prevMap = new Map();
  if (days[1]) for (const b of days[1].results) prevMap.set(b.T, b);
  console.log(`最新交易日：${latest.date}（${latest.results.length} 檔）`);

  const cache = await loadCache();

  // 排名 + 逐檔補明細、濾 ETF、湊滿 50 檔（共用 core.pickTopStocks）。
  const picked = await pickTopStocks(latest.results, prevMap, cache, polygonKey, { log: true });

  // 取得「前一交易日」基準 → 計算 isNew / rankChange / streak（連續在榜天數）。
  // 優先用歷史封存檔（真正的前一交易日，streak 鏈不會被同日重跑/重部署破壞）；無則退回線上前一份。
  const prev = (await readPrevFromHistory(latest.date)) ?? (await fetchPrev());
  // 同一交易日的重跑（例如改程式碼觸發部署）不重複累加 streak。
  const sameDay = prev?.date != null && prev.date === latest.date;
  console.log(
    prev
      ? `已取得前一份快照（${prev.ranks.size} 檔，交易日 ${prev.date}${sameDay ? "，同日重跑" : ""}）作對比`
      : "無前一份快照，新進榜/躍升/在榜天數本次以 1 起算",
  );

  // AI 題材分析（一次呼叫；缺金鑰或失敗則後備）。
  let aiSource = "none";
  let themesByTicker = new Map();
  let summaryRaw = [];
  if (geminiKey) {
    try {
      const aiInput = picked.map((p) => ({
        symbol: p.b.T,
        name: p.meta.name ?? p.b.T,
        sector: formatSector(p.meta.sector ?? "—"),
        changePercent: p.changePercent,
      }));
      const r = await enrichWithGemini(aiInput, geminiKey);
      themesByTicker = r.themesByTicker;
      summaryRaw = r.summary;
      aiSource = "gemini";
      // 將題材標籤寫入快取（後備用）。
      for (const p of picked) {
        const th = themesByTicker.get(p.b.T);
        if (th) {
          cache[p.b.T] = { ...cache[p.b.T], theme: th, themeFetchedAt: Date.now() };
        }
      }
      await saveCache(cache);
      console.log(`Gemini 題材分析完成（${themesByTicker.size} 檔、${summaryRaw.length} 組題材）`);
    } catch (e) {
      console.warn(`Gemini 失敗，改用後備題材：${e.message}`);
    }
  } else {
    console.log("未設定 GEMINI_API_KEY，題材使用 SIC 後備");
  }

  const rows = picked.map((p, i) => {
    const t = p.b.T;
    const currentRank = i + 1;
    const prevRank = prev?.ranks.get(t);
    const inPrev = prev?.ranks.has(t) ?? false;
    // 題材：Gemini → 快取題材（未過期）→ SIC 格式化
    const cached = cache[t];
    const cachedTheme =
      cached?.theme && cached.themeFetchedAt && Date.now() - cached.themeFetchedAt < THEME_TTL_MS
        ? cached.theme
        : null;
    const theme = themesByTicker.get(t) || cachedTheme || formatSector(p.meta.sector ?? "—");

    // 連續在榜天數：在榜→前次 streak（+1，同日重跑不加）；不在榜或無前資料→1。
    let streak;
    if (!prev || !inPrev) {
      streak = 1;
    } else {
      const prevStreak = prev.rows.get(t)?.streak ?? 1;
      streak = sameDay ? prevStreak : prevStreak + 1;
    }

    return {
      symbol: t,
      name: p.meta.name ?? t,
      price: p.b.c,
      changePercent: p.changePercent,
      dollarVolume: p.dv,
      marketCap: p.marketCap,
      sector: p.meta.sector ?? "—",
      theme,
      isNew: prev ? !inPrev : false,
      rankChange: prevRank ? prevRank - currentRank : null,
      streak,
    };
  });

  // 摘要：以我方資料計算 count / avgChange（不信任模型算數），只保留有對應到的成員。
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
  const themeSummary = summaryRaw
    .map((s) => {
      const symbols = (s.symbols ?? []).filter((sym) => bySymbol.has(sym));
      const changes = symbols.map((sym) => bySymbol.get(sym).changePercent);
      const avgChange = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
      return { theme: s.theme, reason: s.reason, symbols, count: symbols.length, avgChange };
    })
    .filter((s) => s.count > 0);

  // 新進榜雷達：對 isNew 的個股用 Gemini + Google 搜尋查近期催化劑。
  let newEntrants = rows
    .filter((r) => r.isNew)
    .map((r) => ({
      symbol: r.symbol,
      name: r.name,
      theme: r.theme,
      changePercent: r.changePercent,
      reason: "",
    }));
  if (geminiKey && newEntrants.length > 0) {
    try {
      const reasons = await explainNewEntrants(newEntrants, geminiKey);
      newEntrants = newEntrants.map((n) => ({ ...n, reason: reasons.get(n.symbol) ?? "" }));
      console.log(`新進榜 AI 說明完成（${reasons.size}/${newEntrants.length} 檔，含 Google 搜尋）`);
    } catch (e) {
      console.warn(`新進榜 AI 說明失敗：${e.message}`);
    }
  }

  // 今日市場焦點：成交重點 + 重大事件（已發生／即將到來），Gemini + Google 搜尋。
  let marketBrief = null;
  if (geminiKey) {
    try {
      const topForBrief = rows.slice(0, 15); // 成交金額最高的前 15 檔（rows 已依成交值排序）
      marketBrief = await marketBriefing(topForBrief, themeSummary, geminiKey, latest.date);
      console.log(
        `今日市場焦點完成（已發生 ${marketBrief.eventsPast.length} 筆、即將 ${marketBrief.eventsUpcoming.length} 筆，含 Google 搜尋）`,
      );
    } catch (e) {
      console.warn(`今日市場焦點失敗：${e.message}`);
    }
  }

  const out = {
    rows,
    asOf: new Date(`${latest.date}T20:00:00Z`).toISOString(),
    generatedAt: new Date().toISOString(), // 本次快照實際產生時間（可看出每日是否有跑）
    source: "polygon",
    aiSource,
    themeSummary,
    newEntrants,
    marketBriefing: marketBrief,
  };
  // 防呆：本次接地 AI（今日市場焦點／發動題材／新進榜說明）若偶發回空，沿用同交易日
  // 既有值，避免早班（Polygon 閘門前）或 Gemini 回空的重跑把前一班的好資料洗掉。
  await preserveGroundedAI(out, path.join(HISTORY_DIR, `${latest.date}.json`));

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2), "utf8");

  // 另存歷史快照（以交易日命名）並重建 index.json / trends.json，供前端切換與走勢圖。
  await writeHistory(out);

  const newCount = rows.filter((r) => r.isNew).length;
  console.log(
    `完成：寫出 ${rows.length} 檔個股 → public/rankings.json + public/history/${latest.date}.json（AI=${aiSource}，新進榜 ${newCount} 檔）`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
