/**
 * SkillsRegistryClient — read-only HTTP access to the skills.sh registry.
 *
 * Uses the same undocumented endpoints the `skills` CLI drives:
 *   GET /api/search?q=…&limit=…                  -> { skills: [{ id, skillId, name, source, installs }] }
 *   GET /api/download/:owner/:repo/:skillId      -> { files: [{ path, contents }] }
 * There is no versioned public contract, so decoding drops malformed entries
 * instead of failing the whole response, and detail fetches cap file sizes.
 *
 * @module skillStore/SkillsRegistryClient
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  SKILL_STORE_DETAIL_MAX_FILE_BYTES,
  SkillStoreError,
  type SkillStoreDetail,
  type SkillStoreEntry,
  type SkillStoreFile,
} from "@t3tools/contracts";

const REGISTRY_BASE_URL = "https://skills.sh";
const REGISTRY_TIMEOUT_MS = 10_000;

const RegistrySearchEntry = Schema.Struct({
  id: Schema.String,
  skillId: Schema.String,
  name: Schema.String,
  source: Schema.optional(Schema.String),
  installs: Schema.optional(Schema.Number),
});

const RegistrySearchResponse = Schema.Struct({
  skills: Schema.Array(Schema.Unknown),
});

const RegistryDownloadResponse = Schema.Struct({
  files: Schema.Array(Schema.Unknown),
});

const RegistryFile = Schema.Struct({
  path: Schema.String,
  contents: Schema.String,
});

const decodeSearchResponse = Schema.decodeUnknownEffect(RegistrySearchResponse);
const decodeDownloadResponse = Schema.decodeUnknownEffect(RegistryDownloadResponse);
const isRegistryEntry = Schema.is(RegistrySearchEntry);
const isRegistryFile = Schema.is(RegistryFile);

const registryUnavailable = (detail: string, cause?: unknown) =>
  new SkillStoreError({ reason: "registryUnavailable", detail, cause });

const getJson = Effect.fn("SkillsRegistryClient.getJson")(function* (url: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("accept", "application/json")),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeoutOption(REGISTRY_TIMEOUT_MS),
      Effect.mapError((cause) => registryUnavailable(`GET ${url} failed`, cause)),
    );
  if (Option.isNone(response)) {
    return yield* registryUnavailable(`GET ${url} timed out`);
  }
  return yield* response.value.json.pipe(
    Effect.mapError((cause) => registryUnavailable(`GET ${url} returned invalid JSON`, cause)),
  );
});

/** Extract `name`/`description` from a SKILL.md YAML frontmatter block without a YAML dependency. */
export function parseSkillMdFrontmatter(contents: string): {
  readonly name?: string;
  readonly description?: string;
} {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = match?.[1];
  if (!block) {
    return {};
  }
  const readField = (field: string): string | undefined => {
    const fieldMatch = block.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m"));
    if (!fieldMatch?.[1]) {
      return undefined;
    }
    // Strip one layer of matching quotes; frontmatter descriptions are often quoted.
    return fieldMatch[1].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  };
  const name = readField("name");
  const description = readField("description");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

const truncateContents = (contents: string): string =>
  contents.length <= SKILL_STORE_DETAIL_MAX_FILE_BYTES
    ? contents
    : contents.slice(0, SKILL_STORE_DETAIL_MAX_FILE_BYTES);

export const searchRegistry = Effect.fn("SkillsRegistryClient.search")(function* (
  query: string,
  limit: number,
): Effect.fn.Return<ReadonlyArray<SkillStoreEntry>, SkillStoreError, HttpClient.HttpClient> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const json = yield* getJson(`${REGISTRY_BASE_URL}/api/search?${params.toString()}`);
  const decoded = yield* decodeSearchResponse(json).pipe(
    Effect.mapError((cause) =>
      registryUnavailable("Registry search response did not decode", cause),
    ),
  );
  return decoded.skills.filter(isRegistryEntry).map((skill) => ({
    id: skill.id,
    skillId: skill.skillId,
    name: skill.name,
    source: skill.source ?? skill.id.split("/").slice(0, 2).join("/"),
    installs: skill.installs ?? 0,
    url: `${REGISTRY_BASE_URL}/${skill.id}`,
  }));
});

export const fetchSkillDetail = Effect.fn("SkillsRegistryClient.fetchSkillDetail")(
  function* (input: {
    readonly source: string;
    readonly skillId: string;
  }): Effect.fn.Return<SkillStoreDetail, SkillStoreError, HttpClient.HttpClient> {
    const [owner, repo] = input.source.split("/");
    if (!owner || !repo) {
      return yield* new SkillStoreError({
        reason: "invalidInput",
        detail: `Skill source '${input.source}' is not an '<owner>/<repo>' pair`,
      });
    }
    const json = yield* getJson(
      `${REGISTRY_BASE_URL}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(input.skillId)}`,
    );
    const decoded = yield* decodeDownloadResponse(json).pipe(
      Effect.mapError((cause) =>
        registryUnavailable("Skill download response did not decode", cause),
      ),
    );
    const files: ReadonlyArray<SkillStoreFile> = decoded.files
      .filter(isRegistryFile)
      .map((file) => ({
        path: file.path,
        contents: truncateContents(file.contents),
      }));
    if (files.length === 0) {
      return yield* new SkillStoreError({
        reason: "notFound",
        detail: `Skill '${input.skillId}' was not found in ${input.source}`,
      });
    }
    const skillMd = files.find((file) => file.path.toLowerCase().endsWith("skill.md"));
    const frontmatter = skillMd ? parseSkillMdFrontmatter(skillMd.contents) : {};
    return {
      id: `${input.source}/${input.skillId}`,
      skillId: input.skillId,
      name: frontmatter.name ?? input.skillId,
      description: frontmatter.description ?? null,
      source: input.source,
      url: `${REGISTRY_BASE_URL}/${input.source}/${input.skillId}`,
      files,
    };
  },
);
