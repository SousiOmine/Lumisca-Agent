import {
  createUiAppState,
  parseAppSpec,
  parseAppSpecPartial,
} from "@lumisca/core/shared";
import { useMemo } from "preact/hooks";
import { useT } from "../../i18n.ts";
import { AppRenderer } from "./AppRenderer.tsx";
import { useAppState } from "./useAppState.ts";

/**
 * One app card in a reply: the JSON spec parsed, its own state, and the
 * component tree drawn from it.
 *
 * The card is part of the message, so it is parsed from the message's own
 * text every time it is drawn. The state belongs to this mounted card: a
 * reload, a re-read window, or a second client starts from `state` again.
 * While the spec is still being written, the readable part is drawn but
 * every control is inert; the finished message starts the card once.
 */
export function AppCard({
  json,
  onSend,
  streaming = false,
}: {
  /** The JSON between the `ui` fence's delimiters. */
  json: string;
  /** Send a `sendMessage` action as the user's next message. Omitted in a
   * read-only conversation. */
  onSend?: (text: string) => void;
  /** The fence is still open: draw what parses, accept no input. */
  streaming?: boolean;
}) {
  const t = useT();
  const parsed = useMemo(
    () => (streaming ? parseAppSpecPartial(json) : parseAppSpec(json)),
    [json, streaming],
  );
  const spec = parsed.ok ? parsed.spec : null;
  const store = useMemo(() => createUiAppState(spec?.state ?? {}), [spec]);
  const state = useAppState(store);

  if (spec === null) {
    if (streaming) {
      return (
        <section className="app-card app-card-building" aria-busy="true">
          <span className="app-card-building-text">
            {t("panels.ui.buildingApp")}
          </span>
        </section>
      );
    }
    return (
      <InvalidAppCard json={json} problem={parsed.ok ? "" : parsed.problem} />
    );
  }

  return (
    <section className="app-card">
      {spec.title !== undefined && (
        <div className="app-card-title" role="heading" aria-level={3}>
          {spec.title}
        </div>
      )}
      {spec.description !== undefined && (
        <p className="app-card-description">{spec.description}</p>
      )}
      <div className="app-card-body">
        <AppRenderer
          spec={spec}
          store={store}
          state={state}
          onSend={onSend}
          disabled={streaming || onSend === undefined}
        />
      </div>
    </section>
  );
}

/** A card the reader refused: the note, the parser's reason, and the JSON
 * behind a disclosure. The source is the agent's own words, so a card that
 * could not be drawn must not swallow them. */
function InvalidAppCard({ json, problem }: { json: string; problem: string }) {
  const t = useT();
  return (
    <section className="app-card app-card-invalid">
      <p>{t("panels.ui.invalidApp")}</p>
      {problem.length > 0 && <p className="app-card-problem">{problem}</p>}
      <details>
        <summary>{t("panels.ui.spec")}</summary>
        <pre className="app-card-source">{json.trim()}</pre>
      </details>
    </section>
  );
}
