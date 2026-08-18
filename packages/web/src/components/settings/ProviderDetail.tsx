import { useEffect, useRef, useState } from "react";
import {
  IconArrowLeft,
  IconCheck,
  IconCircleDashed,
  IconCopy,
  IconExternalLink,
  IconLoader2,
  IconLogin2,
  IconLogout,
  IconSend,
  IconX,
} from "@tabler/icons-react";
import { api } from "../../api.ts";
import { errorText, useProviders } from "../../providers.ts";
import type {
  ProviderAuthType,
  ProviderLoginEvent,
  ProviderLoginPrompt,
  ProviderLoginSnapshot,
} from "../../types.ts";

/** One running login flow the settings UI is driving (started, then
 * polled until it settles). */
interface LoginFlow {
  sessionId: string;
  snapshot: ProviderLoginSnapshot | undefined;
}

const LOGIN_POLL_MS = 1200;

/** Settings → one provider: OAuth login for subscription providers,
 * API-key entry otherwise. `onBack` returns to the screen this was opened
 * from; `onDone` closes the dialog back to the provider list. */
export function ProviderDetail({
  providerId,
  onBack,
  onDone,
}: {
  providerId: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const { providers, reload: reloadProviders } = useProviders();
  const [auth, setAuth] = useState<{
    configured: boolean;
    source?: string;
    authType?: ProviderAuthType;
  }>({ configured: false });
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [savedNotice, setSavedNotice] = useState(false);
  const [loginFlow, setLoginFlow] = useState<LoginFlow | undefined>();
  const [loginBusy, setLoginBusy] = useState(false);
  const [promptValue, setPromptValue] = useState("");
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    return () => clearTimeout(savedTimer.current);
  }, []);

  const load = async () => {
    const authState = await api.providerAuth(providerId);
    setAuth(authState);
  };

  useEffect(() => {
    let stale = false;
    load().catch((e) => {
      if (!stale) setError(errorText(e));
    });
    return () => {
      stale = true;
    };
  }, [providerId]);

  const provider = providers.find((p) => p.id === providerId);
  const authType = auth.authType ?? provider?.authType;
  const isOAuth = authType === "oauth";

  /** Poll the running flow until it settles; on completion reload the
   * provider auth state (the server freshly resolved it). */
  useEffect(() => {
    if (!loginFlow) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const snapshot = await api.providerLoginPoll(
          providerId,
          loginFlow.sessionId,
        );
        if (cancelled) return;
        setLoginFlow((cur) => (cur ? { ...cur, snapshot } : cur));
        const terminal = snapshot.status !== "starting" &&
          snapshot.status !== "waiting";
        if (!terminal) {
          pollTimer.current = setTimeout(poll, LOGIN_POLL_MS);
        }
      } catch (e) {
        if (!cancelled) {
          setError(errorText(e));
          setLoginFlow(undefined);
        }
      }
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(pollTimer.current);
    };
    // The sessionId identifies the flow; new snapshots arrive through the
    // functional update below without restarting the polling loop.
  }, [loginFlow?.sessionId]);

  /** React to the flow reaching a terminal state. */
  useEffect(() => {
    const status = loginFlow?.snapshot?.status;
    if (!status || status === "starting" || status === "waiting") return;
    if (status === "done") {
      setNotice("ログインしました");
    } else if (status === "error") {
      setError(loginFlow.snapshot?.error ?? "ログインに失敗しました");
    }
    setLoginFlow(undefined);
    load().catch((e) => setError(errorText(e)));
    reloadProviders();
  }, [loginFlow?.snapshot?.status]);

  const saveKey = async () => {
    if (!key.trim()) return;
    setSavingKey(true);
    setError(undefined);
    try {
      await api.setApiKey(providerId, key.trim());
      setKey("");
      setSavedNotice(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedNotice(false), 2000);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSavingKey(false);
    }
  };

  const startLogin = async () => {
    setLoginBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const { sessionId } = await api.providerLogin(providerId);
      setLoginFlow({ sessionId, snapshot: undefined });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoginBusy(false);
    }
  };

  const cancelLogin = async () => {
    const flow = loginFlow;
    if (!flow) return;
    setLoginFlow(undefined);
    try {
      await api.providerLoginCancel(providerId, flow.sessionId);
      setNotice("ログインをキャンセルしました");
    } catch (e) {
      setError(errorText(e));
    }
  };

  const respond = async (promptId: string, value: string) => {
    const flow = loginFlow;
    if (!flow) return;
    setError(undefined);
    try {
      await api.providerLoginRespond(
        providerId,
        flow.sessionId,
        promptId,
        value,
      );
      setPromptValue("");
    } catch (e) {
      setError(errorText(e));
    }
  };

  const logout = async () => {
    setLoginBusy(true);
    setError(undefined);
    try {
      await api.providerLogout(providerId);
      setNotice("ログアウトしました");
      await load();
      reloadProviders();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoginBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("コピーしました");
    } catch {
      setError("コピーに失敗しました");
    }
  };

  const open = (url: string) => {
    globalThis.open(url, "_blank", "noopener");
  };

  const renderEvent = (event: ProviderLoginEvent, index: number) => {
    switch (event.type) {
      case "device_code":
        return (
          <div
            key={index}
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            <p className="settings-note">確認コード</p>
            <div className="login-code">{event.userCode}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn small"
                onClick={() => copy(event.userCode)}
              >
                <IconCopy size={14} /> コピー
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => open(event.verificationUri)}
              >
                <IconExternalLink size={14} /> ログイン画面を開く
              </button>
            </div>
            <p className="settings-note">
              開いた画面でコードを入力して認証を承認してください。
            </p>
          </div>
        );
      case "auth_url":
        return (
          <div
            key={index}
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            <button
              type="button"
              className="btn primary"
              onClick={() => open(event.url)}
            >
              <IconExternalLink size={14} /> ブラウザでログイン
            </button>
            {event.instructions && (
              <p className="settings-note">{event.instructions}</p>
            )}
          </div>
        );
      case "progress":
      case "info":
        return <p key={index} className="settings-note">{event.message}</p>;
    }
  };

  const renderPrompt = (
    prompt: ProviderLoginPrompt & { id: string },
  ) => {
    if (prompt.type === "select") {
      return (
        <div
          key={prompt.id}
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          <p className="settings-note">{prompt.message}</p>
          {prompt.options.map((option) => (
            <button
              type="button"
              key={option.id}
              className="btn"
              onClick={() => respond(prompt.id, option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      );
    }
    const submit = () => {
      if (promptValue.trim()) respond(prompt.id, promptValue.trim());
    };
    const type = prompt.type === "secret" ? "password" : "text";
    return (
      <div
        key={prompt.id}
        style={{ display: "flex", gap: 6, alignItems: "flex-start" }}
      >
        <input
          type={type}
          placeholder={prompt.placeholder}
          value={promptValue}
          onChange={(e) => setPromptValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn primary"
          onClick={submit}
          disabled={!promptValue.trim()}
        >
          <IconSend size={14} /> 送信
        </button>
      </div>
    );
  };

  const snapshot = loginFlow?.snapshot;
  const flowPrompt = snapshot?.prompt;
  const flowTerminal = snapshot !== undefined &&
    snapshot.status !== "starting" && snapshot.status !== "waiting";

  return (
    <>
      <div className="modal-header">
        <button type="button" className="btn" onClick={onBack}>
          <IconArrowLeft size={14} /> 戻る
        </button>
        <h2>{provider?.name ?? providerId}</h2>
        {auth.configured
          ? (
            <span className="provider-state configured">
              <IconCheck size={12} /> {isOAuth ? "ログイン済み" : "設定済み"}
            </span>
          )
          : (
            <span className="provider-state">
              <IconCircleDashed size={12} /> 未設定
            </span>
          )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {isOAuth
          ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p className="settings-note">
                OAuth ログイン(サブスクリプション契約)
              </p>

              {auth.configured && (
                <button
                  type="button"
                  className="btn"
                  onClick={logout}
                  disabled={loginBusy}
                >
                  <IconLogout size={14} /> ログアウト
                </button>
              )}

              {!loginFlow && (
                <button
                  type="button"
                  className="btn primary"
                  onClick={startLogin}
                  disabled={loginBusy}
                >
                  {loginBusy
                    ? <IconLoader2 size={14} className="spin" />
                    : <IconLogin2 size={14} />}
                  {auth.configured ? "再ログイン" : "ログイン"}
                </button>
              )}

              {loginFlow && !flowTerminal && (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  <p
                    className="settings-note"
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <IconLoader2 size={14} className="spin" /> 認証を待機中…
                  </p>
                  {(snapshot?.events ?? []).map(renderEvent)}
                  {flowPrompt && renderPrompt(flowPrompt)}
                  <button type="button" className="btn" onClick={cancelLogin}>
                    <IconX size={14} /> キャンセル
                  </button>
                </div>
              )}

              {snapshot?.status === "done" && (
                <p className="settings-note" style={{ color: "var(--ok)" }}>
                  ログインしました
                </p>
              )}
              {snapshot?.status === "cancelled" && (
                <p className="settings-note">キャンセルしました</p>
              )}
              {snapshot?.status === "error" && (
                <div className="error-text">
                  {snapshot.error ?? "ログインに失敗しました"}
                </div>
              )}
            </div>
          )
          : (
            <>
              <p className="settings-note">APIキー</p>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="password"
                  placeholder={auth.configured
                    ? "新しいAPIキー(上書き)"
                    : "APIキーを入力"}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn primary"
                  onClick={saveKey}
                  disabled={savingKey || !key.trim()}
                >
                  保存
                </button>
              </div>
              {savedNotice && (
                <p className="settings-note" style={{ color: "var(--ok)" }}>
                  APIキーを保存しました
                </p>
              )}
            </>
          )}

        {notice && (
          <p className="settings-note" style={{ color: "var(--ok)" }}>
            {notice}
          </p>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn primary" onClick={onDone}>
          完了
        </button>
      </div>
    </>
  );
}
