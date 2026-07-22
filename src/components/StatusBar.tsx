"use client";

import type { RankingSource } from "@/types/stock";
import { formatTime, formatTradingDate } from "@/lib/format";

interface Props {
  asOf: string | null;
  generatedAt?: string | null;
  source: RankingSource | null;
  aiSource?: "gemini" | "none";
  notice?: string;
  loading: boolean;
}

export default function StatusBar({ asOf, generatedAt, source, aiSource, notice, loading }: Props) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-400">
        <span>
          資料日期：
          <span className="ml-1 font-mono text-slate-200">
            {asOf ? formatTradingDate(asOf) : "—"}
          </span>
          <span className="ml-1 text-xs text-slate-500">（美股收盤）</span>
        </span>
        {generatedAt && (
          <span>
            更新於：
            <span className="ml-1 font-mono text-slate-300">{formatTime(generatedAt)}</span>
            <span className="ml-1 text-xs text-slate-500">（台北系統更新時間，非資料日期）</span>
          </span>
        )}
        {source === "mock" && (
          <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-300">
            示範資料（未設定 API 金鑰）
          </span>
        )}
        {source === "polygon" && (
          <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
            全市場資料 · Polygon（前一交易日收盤）
          </span>
        )}
        {source === "fmp" && (
          <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
            即時資料 · FMP
          </span>
        )}
        {aiSource === "gemini" && (
          <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-medium text-sky-300">
            題材分析 · Gemini
          </span>
        )}
        {aiSource === "none" && (
          <span className="rounded-full bg-slate-600/30 px-2.5 py-0.5 text-xs font-medium text-slate-400">
            AI 未啟用
          </span>
        )}
      </div>

      {loading && <span className="text-xs text-slate-500">更新中…</span>}

      <p className="w-full text-xs leading-relaxed text-slate-500">
        ℹ️ 顯示「前一個美股交易日」的收盤資料；每個交易日約台北 <span className="text-slate-400">13:00–14:00</span> 自動更新（免費資料源於美股收盤後隔日才提供，早上看到的多為前一交易日）。
      </p>

      {notice && (
        <p className="w-full rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {notice}
        </p>
      )}
    </div>
  );
}
