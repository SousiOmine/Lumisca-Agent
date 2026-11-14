/**
 * The first-run setup (packages/web/src/components/setup/): the four steps a
 * new installation walks through before its first conversation.
 *
 * The wizard is its own surface, so its text lives here rather than in
 * `settings.ts`: the steps decide the same things the settings dialog does,
 * but in a different order, with the reader's attention in a different place.
 * What the two screens share — the words for the language, the theme, the
 * default model and "not set" — is reused from `settings.*` instead of being
 * spelled again, so a rewording reaches both.
 */
export const setup = {
  "setup.title": { ja: "初期セットアップ", en: "Initial setup" },
  /** Where the reader is, in the header. */
  "setup.progress": {
    ja: "ステップ {current} / {total}",
    en: "Step {current} of {total}",
  },
  "setup.next": { ja: "次へ", en: "Next" },
  "setup.start": { ja: "はじめる", en: "Start" },

  // --- step 1: welcome ------------------------------------------------------
  "setup.welcome.title": {
    ja: "Lumiscaにようこそ！",
    en: "Welcome to Lumisca!",
  },

  // --- step 2: provider -----------------------------------------------------
  "setup.provider.title": {
    ja: "プロバイダーを接続",
    en: "Connect a provider",
  },
  "setup.provider.popular": {
    ja: "よく使うプロバイダー",
    en: "Common providers",
  },
  "setup.provider.more": {
    ja: "ほかのプロバイダーを探す",
    en: "Find another provider",
  },
  /** State of a row whose provider already has a credential. The settings
   * list says 設定済み for the same fact; the wizard speaks of connecting. */
  "setup.provider.connected": { ja: "接続済み", en: "Connected" },
  "setup.provider.note": {
    ja: "あとで接続する場合は、設定のプロバイダーから接続できます。",
    en: "To connect one later, open Providers in settings.",
  },
  "setup.provider.catalogFailed": {
    ja: "プロバイダーの一覧を読み込めませんでした。設定のプロバイダーから接続できます。",
    en: "The provider list could not be read. Connect one from Providers in settings.",
  },

  // --- step 3: default model ------------------------------------------------
  "setup.model.title": { ja: "既定のモデル", en: "Default model" },
  /** Why the row may stay unset: the resolver has its own answer. */
  "setup.model.auto": {
    ja: "未設定の場合、接続されたプロバイダーから自動で選択されます。",
    en: "When unset, the connected provider's model is chosen automatically.",
  },
  /** The model step without a provider: there is nothing to list. */
  "setup.model.none": {
    ja: "モデルを選択するには、先にプロバイダーを接続してください。",
    en: "Connect a provider first to select a model.",
  },

  // --- step 4: done ---------------------------------------------------------
  "setup.done.title": { ja: "準備ができました", en: "You're all set" },
  "setup.done.providersConnected": {
    ja: "{count}件接続済み",
    en: "{count} connected",
  },
  "setup.done.providersNone": { ja: "未接続", en: "None connected" },

  /** The marker could not be written (a read-only config directory). The
   * wizard stays where it is, so the reason has to say what failed. */
  "setup.completeFailed": {
    ja: "初期セットアップの完了を記録できませんでした: {error}",
    en: "Could not record that setup is complete: {error}",
  },
};
