/**
 * The systemd unit template shipped in the server binary.
 *
 * It is a TypeScript constant rather than a `.in` file read at runtime: the
 * packaged server is one `deno compile` binary, so a separate file would have
 * to sit beside it — a new artifact in the release layout, and a new way for a
 * release to be broken. `deno compile` does inline text imports, but `deno fmt`
 * cannot parse the import-attribute syntax, and the template would then leave
 * the repository's one formatting gate; a constant keeps it inside.
 *
 * `{{name}}` placeholders are substituted by compose.ts, which fails when the
 * template and its values disagree in either direction (a missing value would
 * ship a unit containing `{{execStart}}`, an unused one means the two have
 * drifted apart).
 *
 * The quoting of the four substituted values is decided in compose.ts from
 * measurement, not from the unit-file documentation: `ExecStart=` and
 * `Environment=` unquote their value while `WorkingDirectory=` and
 * `EnvironmentFile=` do not. The inline comment in the template records that,
 * because it is the surprising part for anyone editing this file.
 *
 * The header is for the operator who opens the file in systemd's directory:
 * the values live in the environment file, because reinstalling rewrites this
 * one.
 */
export const SERVICE_UNIT_TEMPLATE =
  `# lumisca-server service install が生成します。このファイルを直接編集しても
# 再インストールで上書きされます。設定値は下の EnvironmentFile に置いてください。
[Unit]
Description=Lumisca server (coding agent)
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
# ExecStart と Environment は引用符を外す解釈、WorkingDirectory と
# EnvironmentFile は引用符を値の一部として扱う (compose.ts の測定結果)。
ExecStart={{execStart}}
WorkingDirectory={{workingDirectory}}
Environment=HOME={{home}}
EnvironmentFile={{environmentFile}}
Restart=always
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
`;
