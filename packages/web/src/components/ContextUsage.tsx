import {
  contextUsageRatio,
  type ContextUsageSummary,
  formatCompactTokens,
  formatContextUsageLine,
  formatPercent1,
} from "@lumisca/core/shared";
import { useT } from "../i18n.ts";

export interface ContextUsageData {
  summary: ContextUsageSummary;
  contextWindow?: number;
}

interface ContextUsageTriggerProps extends ContextUsageData {
  open: boolean;
  onToggle: () => void;
}

/** Compact meter button in the composer footer: the usage percent when the
 * model's window is known, else the raw token count. The full card
 * (ContextUsageCard) opens above it. Hidden by the parent while the
 * session has no usage yet. */
export function ContextUsageTrigger({
  summary,
  contextWindow,
  open,
  onToggle,
}: ContextUsageTriggerProps) {
  const t = useT();
  const ratio = contextUsageRatio(summary, contextWindow);
  const label = ratio !== undefined
    ? formatPercent1(ratio)
    : formatCompactTokens(summary.currentTokens ?? 0);
  const detail = formatContextUsageLine(summary, contextWindow) || label;
  return (
    <button
      type="button"
      className={`ctx-meter${open ? " open" : ""}`}
      onClick={onToggle}
      title={formatContextUsageLine(summary, contextWindow) ||
        t("panels.context.title")}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`${t("panels.context.title")}: ${detail}`}
    >
      <span className="mono">{label}</span>
    </button>
  );
}

/** Floating card above the composer footer (see the reference capture):
 * current usage against the window with a progress bar, plus the
 * session-average cache hit rate. */
export function ContextUsageCard({
  summary,
  contextWindow,
}: ContextUsageData) {
  const t = useT();
  const current = summary.currentTokens ?? 0;
  const ratio = contextUsageRatio(summary, contextWindow);
  const headRight = contextWindow !== undefined && contextWindow > 0
    ? `${formatCompactTokens(current)}/${formatCompactTokens(contextWindow)}${
      ratio === undefined ? "" : ` (${formatPercent1(ratio)})`
    }`
    : formatCompactTokens(current);
  const barPercent = ratio === undefined
    ? 0
    : Math.min(100, Math.max(0, ratio * 100));
  return (
    <div
      className="ctx-popover"
      role="dialog"
      aria-label={t("panels.context.title")}
    >
      <div className="ctx-row">
        <span>{t("panels.context.limit")}</span>
        <span className="mono">{headRight}</span>
      </div>
      {ratio !== undefined && (
        <div
          className="ctx-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(barPercent * 10) / 10}
          aria-label={t("panels.context.usageRate", {
            value: formatPercent1(ratio),
          })}
        >
          <div
            className={`ctx-bar-fill${ratio >= 0.8 ? " warn" : ""}`}
            style={{ width: `${barPercent}%` }}
          />
        </div>
      )}
      <div className="ctx-row">
        <span>{t("panels.context.cacheRate")}</span>
        <span className="mono">
          {summary.averageCacheHitRate === undefined
            ? "—"
            : formatPercent1(summary.averageCacheHitRate)}
        </span>
      </div>
    </div>
  );
}
