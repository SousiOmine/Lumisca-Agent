import { type ReactNode, useEffect, useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import type { ConnectionEntry } from "../../types.ts";
import { api } from "../../api.ts";
import { shellAvailable, shellCall, type ShellState } from "../../shell.ts";

/** A labeled full-width field (label above, input below — matches the
 * other settings forms). */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <p className="settings-note">{label}</p>
      {children}
    </div>
  );
}

const ACTIVE_TAG: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid var(--accent)",
  color: "var(--accent)",
  marginLeft: 8,
};

/** The page URL to open for a connection (`?token=` — the page is
 * token-guarded in production mode). */
function pageUrl(url: string, token: string): string {
  return `${url.replace(/\/+$/, "")}/?token=${encodeURIComponent(token)}`;
}

/** Settings → 接続先サーバー. This list is the federation peer registry:
 * it lives in THIS server's database and is shared by web and desktop
 * clients alike. The desktop shell bridge only handles the local server
 * and UI switching; everything else goes through the same API. */
export function ConnectionList() {
  /** null = probing the shell bridge. */
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [state, setState] = useState<ShellState | null>(null);
  const [servers, setServers] = useState<ConnectionEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const ok = await shellAvailable();
      setDesktop(ok);
      if (ok) {
        shellCall<ShellState>("state").then(setState).catch(() => {});
      }
      await load();
    })();
  }, []);

  const load = async () => {
    setError(null);
    try {
      const { connections } = await api.getConnections();
      setServers(connections);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Run an action; errors land in the top-level error line. */
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connectLocal = () =>
    run(async () => {
      await shellCall("connect-local");
      // success navigates the whole app to the local server
    });

  const connect = (server: ConnectionEntry) =>
    run(async () => {
      if (desktop) {
        // The desktop shell switches the whole WebView.
        await shellCall("connect-remote", {
          url: server.url,
          token: server.token,
        });
      } else {
        // Browser: navigating away IS the switch.
        location.href = pageUrl(server.url, server.token);
      }
    });

  const save = (server: ConnectionEntry) =>
    run(async () => {
      const next = servers.some((s) => s.id === server.id)
        ? servers.map((s) => (s.id === server.id ? server : s))
        : [...servers, server];
      await api.putConnections(next);
      setServers(next);
    });

  const remove = (id: string) =>
    run(async () => {
      if (!globalThis.confirm("このサーバーを削除しますか？")) return;
      const next = servers.filter((s) => s.id !== id);
      await api.putConnections(next);
      setServers(next);
    });

  const update = (id: string, patch: Partial<ConnectionEntry>) =>
    setServers((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...patch } : s))
    );

  const add = () =>
    setServers((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name: "", url: "", token: "" },
    ]);

  /** Browser-mode reachability probe: no-cors resolves when the server
   * answers at all (token auth would answer 401), rejects on network
   * failure. The shell bridge's test does the full token check. */
  const probe = async (url: string) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      await fetch(`${url.replace(/\/+$/, "")}/api/health`, {
        mode: "no-cors",
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { ok: true, text: "到達OK (トークンは接続時に検証されます)" };
    } catch {
      return { ok: false, text: `サーバーに到達できません: ${url}` };
    }
  };

  /** Full token check through the shell bridge (desktop only). */
  const bridgeTest = async (url: string, token: string) => {
    try {
      await shellCall("test", { url, token });
      return { ok: true, text: "接続OK" };
    } catch (e) {
      return {
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      };
    }
  };

  return (
    <>
      <div className="modal-header">
        <h2>接続先サーバー</h2>
      </div>

      {desktop === null && <p className="settings-note">読み込み中…</p>}
      {desktop !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p className="settings-note">
            登録したサーバーのワークスペース・セッションが一覧に表示されます
            (フェデレーション)。リストはこのサーバーのデータベースに保存されます。
          </p>
          <p className="settings-note">
            {desktop
              ? state?.mode === "remote"
                ? `現在の表示: ${state.url ?? ""}`
                : "現在の表示: ローカルサーバー"
              : `現在の表示: このサーバー (${location.origin})`}
          </p>

          {error && <p className="error-text">{error}</p>}

          {desktop && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                background: "var(--surface-2)",
                borderRadius: 8,
              }}
            >
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 600 }}>
                  ローカルサーバー
                  {state?.mode === "local" && (
                    <span style={ACTIVE_TAG}>表示中</span>
                  )}
                </span>
                <p className="settings-note">
                  このPCで起動したサーバーのUIを表示します
                </p>
              </div>
              <button
                type="button"
                className="btn primary"
                disabled={busy || state?.mode === "local"}
                onClick={connectLocal}
              >
                表示
              </button>
            </div>
          )}

          {servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              busy={busy}
              onProbe={desktop
                ? (url, token) => bridgeTest(url, token)
                : (url) =>
                  probe(url)}
              onChange={(patch) => update(server.id, patch)}
              onConnect={() => connect(server)}
              onSave={() => save(server)}
              onDelete={() => remove(server.id)}
            />
          ))}

          <div>
            <button type="button" className="btn" disabled={busy} onClick={add}>
              <IconPlus size={14} /> サーバーを追加
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function ServerCard({
  server,
  busy,
  onProbe,
  onChange,
  onConnect,
  onSave,
  onDelete,
}: {
  server: ConnectionEntry;
  busy: boolean;
  onProbe: (
    url: string,
    token: string,
  ) => Promise<{ ok: boolean; text: string }>;
  onChange: (patch: Partial<ConnectionEntry>) => void;
  onConnect: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const test = async () => {
    setResult(null);
    setTesting(true);
    try {
      setResult(await onProbe(server.url.trim(), server.token));
    } catch (e) {
      setResult({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        background: "var(--surface-2)",
        borderRadius: 8,
      }}
    >
      <span style={{ fontWeight: 600 }}>
        {server.name || "(無名)"}
      </span>
      <Field label="名前">
        <input
          value={server.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="例: 自宅サーバー"
        />
      </Field>
      <Field label="URL">
        <input
          value={server.url}
          onChange={(e) => onChange({ url: e.target.value })}
          placeholder="http://100.64.0.5:8000"
          spellCheck={false}
        />
      </Field>
      <Field label="トークン (LUMISCA_TOKEN と同じ値)">
        <input
          type="password"
          value={server.token}
          onChange={(e) => onChange({ token: e.target.value })}
        />
      </Field>
      {result && (
        <p
          className={result.ok ? undefined : "error-text"}
          style={result.ok ? { color: "#2e7d32", fontSize: 12.5 } : undefined}
        >
          {result.text}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn primary"
          disabled={busy || testing}
          onClick={onConnect}
        >
          表示
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || testing}
          onClick={test}
        >
          テスト
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || testing}
          onClick={onSave}
        >
          保存
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={busy || testing}
          onClick={onDelete}
        >
          <IconTrash size={14} />
        </button>
      </div>
    </div>
  );
}
