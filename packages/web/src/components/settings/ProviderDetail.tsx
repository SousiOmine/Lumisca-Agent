import { useEffect, useRef, useState } from "preact/compat";
import {
  IconArrowLeft,
  IconCheck,
  IconCircleDashed,
  IconCopy,
  IconEdit,
  IconExternalLink,
  IconLoader2,
  IconLogin2,
  IconLogout,
  IconSend,
  IconTrash,
  IconX,
} from "@tabler/icons-preact";
import { api } from "../../api.ts";
import { useT } from "../../i18n.ts";
import { useAsyncEffect } from "../../hooks/useAsync.ts";
import {
  errorText,
  useProviderModels,
  useUserProviders,
} from "../../providers.ts";
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
  onEditUser,
}: {
  providerId: string;
  onBack: () => void;
  onDone: () => void;
  onEditUser?: (providerId: string) => void;
}) {
  const t = useT();
  const { providers, reload: reloadProviders } = useProviderModels("");
  const { ids: userProviderIds, reload: reloadUserProviders } =
    useUserProviders();
  const isUser = userProviderIds.has(providerId);
  const [removing, setRemoving] = useState(false);
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

  useAsyncEffect((isStale) => {
    load().catch((e) => {
      if (!isStale()) setError(errorText(e));
    });
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
      setNotice(t("settings.provider.loginDone"));
    } else if (status === "error") {
      setError(loginFlow.snapshot?.error ?? t("settings.provider.loginFailed"));
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
      // A freshly stored key changes the provider's `configured` verdict:
      // the catalog store feeds the model picker and the composer's send
      // gate, so the change must reach it now (login/logout reload it for
      // the same reason).
      reloadProviders();
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
      setNotice(t("settings.provider.loginCancelledNotice"));
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
      setNotice(t("settings.provider.logoutDone"));
      await load();
      reloadProviders();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoginBusy(false);
    }
  };

  /** Delete a user-defined provider and return to the list. */
  const removeProvider = async () => {
    if (
      !confirm(
        t("settings.provider.deleteConfirm", {
          name: provider?.name ?? providerId,
        }),
      )
    ) {
      return;
    }
    setRemoving(true);
    setError(undefined);
    try {
      await api.deleteUserProvider(providerId);
      reloadUserProviders();
      reloadProviders();
      onDone();
    } catch (e) {
      setError(errorText(e));
      setRemoving(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t("settings.provider.copyDone"));
    } catch {
      setError(t("settings.provider.copyFailed"));
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
            className="stack-6"
          >
            <p className="settings-note">
              {t("settings.provider.deviceCodeLabel")}
            </p>
            <div className="login-code">{event.userCode}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn small"
                onClick={() => copy(event.userCode)}
              >
                <IconCopy size={14} /> {t("settings.provider.copy")}
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => open(event.verificationUri)}
              >
                <IconExternalLink size={14} />{" "}
                {t("settings.provider.openLoginScreen")}
              </button>
            </div>
            <p className="settings-note">
              {t("settings.provider.deviceCodeHint")}
            </p>
          </div>
        );
      case "auth_url":
        return (
          <div
            key={index}
            className="stack-6"
          >
            <button
              type="button"
              className="btn primary"
              onClick={() => open(event.url)}
            >
              <IconExternalLink size={14} />{" "}
              {t("settings.provider.loginInBrowser")}
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
          className="stack-6"
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
          onChange={(e) => setPromptValue(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn primary"
          onClick={submit}
          disabled={!promptValue.trim()}
        >
          <IconSend size={14} /> {t("settings.provider.send")}
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
          <IconArrowLeft size={14} /> {t("common.back")}
        </button>
        <h2>{provider?.name ?? providerId}</h2>
        {auth.configured
          ? (
            <span className="provider-state configured">
              <IconCheck size={12} /> {isOAuth
                ? t("settings.provider.loginStatus")
                : t("settings.provider.configured")}
            </span>
          )
          : (
            <span className="provider-state">
              <IconCircleDashed size={12} />{" "}
              {t("settings.provider.notConfigured")}
            </span>
          )}
      </div>

      <div className="stack-8">
        {isOAuth
          ? (
            <div className="stack-8">
              <p className="settings-note">
                {t("settings.provider.oauthDescription")}
              </p>

              {auth.configured && (
                <button
                  type="button"
                  className="btn"
                  onClick={logout}
                  disabled={loginBusy}
                >
                  <IconLogout size={14} /> {t("settings.provider.logout")}
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
                  {auth.configured
                    ? t("settings.provider.relogin")
                    : t("settings.provider.login")}
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
                    <IconLoader2 size={14} className="spin" />{" "}
                    {t("settings.provider.authWaiting")}
                  </p>
                  {(snapshot?.events ?? []).map(renderEvent)}
                  {flowPrompt && renderPrompt(flowPrompt)}
                  <button type="button" className="btn" onClick={cancelLogin}>
                    <IconX size={14} /> {t("common.cancel")}
                  </button>
                </div>
              )}

              {snapshot?.status === "done" && (
                <p className="settings-note" style={{ color: "var(--ok)" }}>
                  {t("settings.provider.loginDone")}
                </p>
              )}
              {snapshot?.status === "cancelled" && (
                <p className="settings-note">
                  {t("settings.provider.loginCancelled")}
                </p>
              )}
              {snapshot?.status === "error" && (
                <div className="error-text">
                  {snapshot.error ?? t("settings.provider.loginFailed")}
                </div>
              )}
            </div>
          )
          : (
            <>
              <p className="settings-note">
                {t("settings.provider.apiKeyLabel")}
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="password"
                  placeholder={auth.configured
                    ? t("settings.provider.apiKeyPlaceholderOverwrite")
                    : t("settings.provider.apiKeyPlaceholderNew")}
                  value={key}
                  onChange={(e) => setKey(e.currentTarget.value)}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn primary"
                  onClick={saveKey}
                  disabled={savingKey || !key.trim()}
                >
                  {t("common.save")}
                </button>
              </div>
              {savedNotice && (
                <p className="settings-note" style={{ color: "var(--ok)" }}>
                  {t("settings.provider.apiKeySaved")}
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
        {isUser && (
          <>
            {onEditUser && (
              <button
                type="button"
                className="btn"
                onClick={() => onEditUser(providerId)}
              >
                <IconEdit size={14} /> {t("settings.provider.edit")}
              </button>
            )}
            <button
              type="button"
              className="btn danger"
              onClick={removeProvider}
              disabled={removing}
            >
              <IconTrash size={14} /> {t("common.delete")}
            </button>
          </>
        )}
        <button type="button" className="btn primary" onClick={onDone}>
          {t("settings.provider.done")}
        </button>
      </div>
    </>
  );
}
