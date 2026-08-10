import { errorMessage } from "../errors.ts";

/** Canonical identifier of the plugin manifest schema this client
 * implements (Agent Plugins 1.0.0). Clients must select validation rules
 * from a locally supported schema and never fetch schemas while loading. */
export const PLUGIN_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/** Locally supported manifest schema versions (1.0.0 only). */
const SUPPORTED_PLUGIN_SCHEMAS = new Set([PLUGIN_SCHEMA_URL]);

/** Plugin-name rule: 1–64 chars, lowercase alphanumeric plus single `-`
 * and `.` separators; must start and end alphanumeric; `--` and `..`
 * sequences are forbidden. */
export const PLUGIN_NAME_PATTERN =
  /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export const MAX_PLUGIN_NAME_LENGTH = 64;

export interface PluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

/** The validated plugin.json manifest (closed schema: only these fields
 * are allowed at the top level). */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  /** Client-specific data keyed by reverse-domain namespaces. Values of
   * namespaces this client does not implement are not validated. */
  extensions?: Record<string, unknown>;
}

export interface ManifestLoadResult {
  /** The validated manifest; undefined when the plugin is rejected. */
  manifest?: PluginManifest;
  /** Fatal violation: the whole plugin must be rejected (no component
   * discovery, no execution). */
  fatal?: string;
  /** Non-fatal issues: reported but ignored. */
  warnings: string[];
}

/** Whether a `$schema` value is one of the locally supported plugin
 * manifest schemas. */
export function isSupportedPluginSchema(schema: unknown): boolean {
  return typeof schema === "string" && SUPPORTED_PLUGIN_SCHEMAS.has(schema);
}

/** Parse and validate plugin.json. Throws nothing: fatal violations are
 * returned in `fatal`, non-fatal ones (unknown top-level fields, a
 * non-object `extensions`) are collected as warnings. */
export function parsePluginManifest(
  text: string,
  filePath: string,
): ManifestLoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return fatal(`${filePath} is not valid JSON: ${errorMessage(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fatal(`${filePath} must contain a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const warnings: string[] = [];

  const schema = obj.$schema;
  if (!isSupportedPluginSchema(schema)) {
    return fatal(
      `${filePath} has an unsupported $schema; supported: ${PLUGIN_SCHEMA_URL}`,
    );
  }

  const name = obj.name;
  if (typeof name !== "string" || !isValidPluginName(name)) {
    return fatal(
      `${filePath} has an invalid "name": ` +
        `1-${MAX_PLUGIN_NAME_LENGTH} chars, lowercase alphanumeric with ` +
        `single "-"/"." separators (no leading/trailing, no "--" or "..")`,
    );
  }

  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
      // Unknown top-level fields: report and ignore (non-fatal).
      warnings.push(`${filePath}: unknown top-level field "${key}" ignored`);
    }
  }

  const version = asOptionalString(obj.version);
  if (version === invalid) {
    return fatal(`${filePath}: "version" must be a string`);
  }
  const description = asOptionalString(obj.description);
  if (description === invalid) {
    return fatal(`${filePath}: "description" must be a string`);
  }
  const homepage = asOptionalString(obj.homepage);
  if (homepage === invalid) {
    return fatal(`${filePath}: "homepage" must be a string`);
  }
  const repository = asOptionalString(obj.repository);
  if (repository === invalid) {
    return fatal(`${filePath}: "repository" must be a string`);
  }
  const license = asOptionalString(obj.license);
  if (license === invalid) {
    return fatal(`${filePath}: "license" must be a string`);
  }

  let author: PluginAuthor | undefined;
  if (obj.author !== undefined) {
    if (
      typeof obj.author !== "object" || obj.author === null ||
      Array.isArray(obj.author)
    ) {
      return fatal(`${filePath}: "author" must be an object`);
    }
    const authorObj = obj.author as Record<string, unknown>;
    for (const key of Object.keys(authorObj)) {
      if (key !== "name" && key !== "email" && key !== "url") {
        return fatal(`${filePath}: "author" has an unknown field "${key}"`);
      }
      if (authorObj[key] !== undefined && typeof authorObj[key] !== "string") {
        return fatal(`${filePath}: "author".${key} must be a string`);
      }
    }
    author = {
      ...(authorObj.name !== undefined ? { name: authorObj.name } : {}),
      ...(authorObj.email !== undefined ? { email: authorObj.email } : {}),
      ...(authorObj.url !== undefined ? { url: authorObj.url } : {}),
    } as PluginAuthor;
  }

  let keywords: string[] | undefined;
  if (obj.keywords !== undefined) {
    if (
      !Array.isArray(obj.keywords) ||
      obj.keywords.some((k) => typeof k !== "string")
    ) {
      return fatal(`${filePath}: "keywords" must be an array of strings`);
    }
    keywords = obj.keywords as string[];
  }

  if (obj.extensions !== undefined) {
    if (
      typeof obj.extensions !== "object" || obj.extensions === null ||
      Array.isArray(obj.extensions)
    ) {
      // Non-object extensions: report and ignore (non-fatal).
      warnings.push(`${filePath}: "extensions" is not an object; ignored`);
    }
  }

  return {
    manifest: {
      name,
      ...(version !== undefined ? { version } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(homepage !== undefined ? { homepage } : {}),
      ...(repository !== undefined ? { repository } : {}),
      ...(license !== undefined ? { license } : {}),
      ...(keywords !== undefined ? { keywords } : {}),
      ...(typeof obj.extensions === "object" && obj.extensions !== null &&
          !Array.isArray(obj.extensions)
        ? { extensions: obj.extensions as Record<string, unknown> }
        : {}),
    },
    warnings,
  };
}

function isValidPluginName(name: string): boolean {
  return name.length <= MAX_PLUGIN_NAME_LENGTH &&
    PLUGIN_NAME_PATTERN.test(name);
}

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

/** Sentinel for "present but the wrong type" (vs. absent). */
const invalid = Symbol("invalid");

function asOptionalString(
  value: unknown,
): string | undefined | typeof invalid {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return invalid;
  return value;
}

function fatal(message: string): ManifestLoadResult {
  return { fatal: message, warnings: [] };
}
