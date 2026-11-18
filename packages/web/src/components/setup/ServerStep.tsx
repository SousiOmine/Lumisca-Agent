import { errorMessage } from "@lumisca/core/shared";
import { useState } from "preact/hooks";
import { api } from "../../api.ts";
import {
  connectionLabel,
  isSupportedUrl,
  putConnections,
  upsertConnection,
  withUrl,
} from "../../connections.ts";
import { useT } from "../../i18n.ts";
import { shellCall } from "../../shell.ts";
import { Field } from "../Field.tsx";

export interface ServerStepProps {
  /** Enter the local walk: set this server up instead of another one. */
  onUseLocal: () => void;
}

/**
 * The desktop wizard's first screen: which server this window should show.
 *
 * The app is a client of a server, and this computer's server is one of the
 * choices — the one this page happens to be served by. A reader who already
 * runs Lumisca elsewhere should not have to set up a second installation
 * here first, so the remote server is the screen's form and the local walk
 * is the quiet way out under it.
 *
 * Everything the switch needs is written before the window moves, because
 * none of it can be written afterwards: the page the window is about to load
 * is a different server's page. `test` runs first so a wrong address or
 * token leaves nothing behind; the registry row and the completion marker are
 * written only once the target answered.
 */
export function ServerStep({ onUseLocal }: ServerStepProps) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    const target = url.trim();
    if (!isSupportedUrl(target)) {
      setError(t("settings.connection.badUrl"));
      return;
    }
    setBusy(true);
    setError(null);
    /** The row the picker will list: the typed name, or the host the
     * address names — the same label the picker shows. */
    const entry = withUrl(
      { id: crypto.randomUUID(), name, url: target, token },
      target,
    );
    try {
      await shellCall("test", { url: target, token });
      try {
        const { connections } = await api.getConnections();
        await putConnections(upsertConnection(connections, entry));
      } catch (failure) {
        throw new Error(
          t("setup.server.saveFailed", { error: errorMessage(failure) }),
        );
      }
      try {
        await api.completeSetup();
      } catch (failure) {
        throw new Error(
          t("setup.completeFailed", { error: errorMessage(failure) }),
        );
      }
      // The shell probes once more, remembers the server for the next
      // launch, and navigates the window to it.
      await shellCall("connect-remote", {
        url: target,
        token,
        name: connectionLabel(entry),
      });
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="setup-step-title">{t("setup.server.title")}</h2>
      <form
        className="setup-server-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={t("settings.connection.urlLabel")}>
          <input
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
            placeholder="https://host.tailnet.ts.net"
            spellcheck={false}
          />
        </Field>
        <Field label={t("settings.connection.tokenLabel")}>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
          />
        </Field>
        <Field label={t("settings.connection.serverNameLabel")}>
          <input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder={t("settings.connection.serverNamePlaceholder")}
          />
        </Field>
        {error !== null && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="setup-server-submit">
          <button type="submit" className="btn primary" disabled={busy}>
            {t("setup.server.connect")}
          </button>
        </div>
      </form>
      <div className="setup-alt">
        <button
          type="button"
          className="btn setup-local"
          disabled={busy}
          onClick={onUseLocal}
        >
          {t("setup.server.local")}
        </button>
      </div>
    </>
  );
}
