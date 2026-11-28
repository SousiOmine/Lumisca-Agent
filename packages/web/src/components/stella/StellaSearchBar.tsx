import { IconSearch, IconX } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { stellaApi } from "../../api-stella.ts";
import { formatClockTime, formatDaySeparator } from "../../format.ts";
import { useLocale, useT } from "../../i18n.ts";
import { entryKey } from "../../stella-state.ts";
import type { StellaEntry } from "../../types.ts";

const SEARCH_DEBOUNCE_MS = 200;

export interface StellaSearchBarProps {
  agentId: string;
  agentName: string;
  onClose: () => void;
  /** Jump to a matching entry in the transcript if it is currently loaded.
   * Returns true when the entry was found and scrolled into view. */
  onJumpToEntry: (key: string) => boolean;
}

/** In-conversation search bar for stella mode: queries the server across the
 * full stored transcript (including turns before compaction checkpoints). */
export function StellaSearchBar({
  agentId,
  agentName,
  onClose,
  onJumpToEntry,
}: StellaSearchBarProps) {
  const t = useT();
  const locale = useLocale();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StellaEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [agentId]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults(null);
      setSearching(false);
      setFailed(false);
      setExpandedKey(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setFailed(false);
    const timer = setTimeout(() => {
      void stellaApi
        .search(agentId, trimmed)
        .then((res) => {
          if (cancelled) return;
          setResults(res.entries);
        })
        .catch(() => {
          if (cancelled) return;
          setFailed(true);
          setResults(null);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [agentId, query]);

  const handleSelect = (entry: StellaEntry) => {
    const key = entryKey(entry);
    if (onJumpToEntry(key)) return;
    setExpandedKey((prev) => (prev === key ? null : key));
  };

  return (
    <div className="stella-search-panel">
      <div className="stella-search-bar">
        <IconSearch
          size={16}
          className="stella-search-icon"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="search"
          className="stella-search-input"
          value={query}
          placeholder={t("chat.stella.search.placeholder")}
          aria-label={t("chat.stella.search.open")}
          onInput={(event) =>
            setQuery((event.currentTarget as HTMLInputElement).value)
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        {results !== null && !searching && (
          <span className="stella-search-count" role="status">
            {t("chat.stella.search.count", { count: results.length })}
          </span>
        )}
        <button
          type="button"
          className="icon-btn stella-search-close"
          onClick={onClose}
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <IconX size={16} />
        </button>
      </div>
      {failed && (
        <p className="stella-search-note error-text" role="alert">
          {t("chat.stella.search.failed")}
        </p>
      )}
      {results !== null && !failed && results.length === 0 && !searching && (
        <p className="stella-search-note" role="status">
          {t("chat.stella.search.empty")}
        </p>
      )}
      {results !== null && results.length > 0 && (
        <div className="stella-search-results">
          {results.map((entry) => {
            const key = entryKey(entry);
            const expanded = expandedKey === key;
            const speaker =
              entry.role === "user" ? t("chat.stella.search.you") : agentName;
            const body =
              entry.text ||
              [
                ...entry.attachments.map((file) => file.displayName),
                ...entry.files.map((file) => file.name),
              ].join(", ");
            return (
              <button
                key={key}
                type="button"
                className={`stella-search-hit${expanded ? " expanded" : ""}`}
                onClick={() => handleSelect(entry)}
              >
                <span className="stella-search-hit-meta">
                  <span className="stella-search-hit-speaker">{speaker}</span>
                  <span className="stella-search-hit-time">
                    {formatDaySeparator(entry.timestamp, locale)}{" "}
                    {formatClockTime(entry.timestamp, locale)}
                  </span>
                </span>
                <span className="stella-search-hit-text">{body}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
