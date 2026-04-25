import { isIP } from "node:net";
import type {
  TelegramMessageEntity,
  TelegramMessageEntityType,
  TelegramRenderWarning,
  TelegramRenderWarningCode,
  TelegramRenderedMessage,
} from "./types.js";

export const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;
export const TELEGRAM_MESSAGE_MAX_CHUNKS = 20;
const TELEGRAM_TRUNCATION_NOTICE = "\n\n… [Telegram notification truncated]";
export const TELEGRAM_CONTINUATION_SUFFIX = "\n…continued";
export const TELEGRAM_CONTINUATION_PREFIX = "continued…\n";

const NON_SPLITTABLE_ENTITY_TYPES = new Set<TelegramMessageEntityType>([
  "code",
  "pre",
  "text_link",
]);

const CODE_ENTITY_TYPES = new Set<TelegramMessageEntityType>(["code", "pre"]);
const BLOCKQUOTE_ENTITY_TYPES = new Set<TelegramMessageEntityType>([
  "blockquote",
  "expandable_blockquote",
]);

const SENSITIVE_QUERY_PARAM_NAMES = new Set([
  "access_key",
  "access-token",
  "access_token",
  "apikey",
  "api-key",
  "api_key",
  "authorization",
  "auth",
  "secret",
  "signature",
  "sig",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
]);

export interface TelegramEntityValidationResult {
  text: string;
  entities: TelegramMessageEntity[];
  warnings: string[];
  structuredWarnings: TelegramRenderWarning[];
}

export interface TelegramChunkingOptions {
  continuationMarkers?: boolean;
  continuationPrefix?: string;
  continuationSuffix?: string;
}

interface IndexedEntity extends TelegramMessageEntity {
  originalIndex: number;
}

export function utf16Length(text: string): number {
  return text.length;
}

function pushTelegramRenderWarning(
  warnings: string[],
  structuredWarnings: TelegramRenderWarning[],
  warning: TelegramRenderWarning,
): void {
  warnings.push(warning.message);
  structuredWarnings.push(warning);
}

function isPrivateOrReservedIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [first, second, third] = parts;
  return (
    first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 198 && second >= 18 && second <= 19)
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224
  );
}

function isPrivateOrReservedIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
    || normalized.startsWith("2001:db8:")
  ) {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    const mappedIpv4 = normalized.slice("::ffff:".length);
    return isIP(mappedIpv4) === 4 ? isPrivateOrReservedIpv4(mappedIpv4) : true;
  }

  return false;
}

const LOCAL_ADDRESS_ALIAS_DOMAINS = new Set([
  "localtest.me",
  "lvh.me",
  "nip.io",
  "sslip.io",
  "xip.io",
]);

function hostnameIsOrEndsWith(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function isKnownLocalAddressAliasHostname(hostname: string): boolean {
  for (const suffix of LOCAL_ADDRESS_ALIAS_DOMAINS) {
    if (hostnameIsOrEndsWith(hostname, suffix)) {
      return true;
    }
  }
  return false;
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const withoutIpv6Brackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const normalized = withoutIpv6Brackets.toLowerCase().replace(/\.$/u, "");
  if (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || isKnownLocalAddressAliasHostname(normalized)
  ) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateOrReservedIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isPrivateOrReservedIpv6(normalized);
  }

  return false;
}

function hasSensitiveQueryParams(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_PARAM_NAMES.has(key.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export type TelegramLinkSafetyReason =
  | "missing"
  | "invalid"
  | "unsupported-protocol"
  | "credentials"
  | "local-or-private"
  | "sensitive-query";

export interface TelegramLinkSafetyResult {
  safe: boolean;
  reason?: TelegramLinkSafetyReason;
  warningCode?: Extract<
    TelegramRenderWarningCode,
    "unsafe-url-dropped" | "sensitive-url-dropped" | "local-url-dropped"
  >;
  redactedValue?: string;
}

function redactSearchParams(parsed: URL): string {
  const clone = new URL(parsed.toString());
  for (const key of [...clone.searchParams.keys()]) {
    clone.searchParams.set(
      key,
      SENSITIVE_QUERY_PARAM_NAMES.has(key.toLowerCase()) ? "[redacted]" : "[value]",
    );
  }
  clone.hash = clone.hash ? "#[fragment]" : "";
  return clone.toString();
}

export function redactTelegramDiagnosticValue(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `${parsed.protocol}//[redacted]`;
    }

    if (parsed.username || parsed.password) {
      parsed.username = "[redacted]";
      parsed.password = "";
    }

    return redactSearchParams(parsed);
  } catch {
    return value.length > 80 ? `${value.slice(0, 32)}…[redacted]` : "[invalid-url]";
  }
}

export function classifyTelegramLinkUrl(url: string | undefined): TelegramLinkSafetyResult {
  if (!url) {
    return {
      safe: false,
      reason: "missing",
      warningCode: "unsafe-url-dropped",
    };
  }

  try {
    const parsed = new URL(url);
    const redactedValue = redactTelegramDiagnosticValue(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        safe: false,
        reason: "unsupported-protocol",
        warningCode: "unsafe-url-dropped",
        redactedValue,
      };
    }
    if (parsed.username || parsed.password) {
      return {
        safe: false,
        reason: "credentials",
        warningCode: "sensitive-url-dropped",
        redactedValue,
      };
    }
    if (isLocalOrPrivateHostname(parsed.hostname)) {
      return {
        safe: false,
        reason: "local-or-private",
        warningCode: "local-url-dropped",
        redactedValue,
      };
    }
    if (hasSensitiveQueryParams(parsed)) {
      return {
        safe: false,
        reason: "sensitive-query",
        warningCode: "sensitive-url-dropped",
        redactedValue,
      };
    }
    return { safe: true };
  } catch {
    return {
      safe: false,
      reason: "invalid",
      warningCode: "unsafe-url-dropped",
      redactedValue: redactTelegramDiagnosticValue(url),
    };
  }
}

export function isSafeTelegramLinkUrl(url: string | undefined): url is string {
  return classifyTelegramLinkUrl(url).safe;
}

export function sanitizeTelegramPreLanguage(
  language: string | undefined,
): string | undefined {
  const normalized = language?.trim();
  if (!normalized) {
    return undefined;
  }
  return /^[A-Za-z0-9_+.-]{1,32}$/.test(normalized) ? normalized : undefined;
}

function entityEnd(entity: Pick<TelegramMessageEntity, "offset" | "length">): number {
  return entity.offset + entity.length;
}

function rangesOverlap(
  left: Pick<TelegramMessageEntity, "offset" | "length">,
  right: Pick<TelegramMessageEntity, "offset" | "length">,
): boolean {
  return left.offset < entityEnd(right) && right.offset < entityEnd(left);
}

function rangeContains(
  outer: Pick<TelegramMessageEntity, "offset" | "length">,
  inner: Pick<TelegramMessageEntity, "offset" | "length">,
): boolean {
  return outer.offset <= inner.offset && entityEnd(inner) <= entityEnd(outer);
}

function rangesPartiallyOverlap(
  left: Pick<TelegramMessageEntity, "offset" | "length">,
  right: Pick<TelegramMessageEntity, "offset" | "length">,
): boolean {
  return (
    rangesOverlap(left, right)
    && !rangeContains(left, right)
    && !rangeContains(right, left)
  );
}

function isTrailingEntityWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function trimEntityRange(
  text: string,
  entity: TelegramMessageEntity,
): TelegramMessageEntity | null {
  let end = entityEnd(entity);
  while (end > entity.offset && isTrailingEntityWhitespace(text.slice(end - 1, end))) {
    end -= 1;
  }

  const length = end - entity.offset;
  if (length <= 0) {
    return null;
  }

  return {
    ...entity,
    length,
  };
}

function normalizeEntityMetadata(
  entity: TelegramMessageEntity,
  warnings: string[],
  structuredWarnings: TelegramRenderWarning[],
): TelegramMessageEntity | null {
  if (entity.type === "text_link") {
    const linkSafety = classifyTelegramLinkUrl(entity.url);
    if (!linkSafety.safe) {
      pushTelegramRenderWarning(warnings, structuredWarnings, {
        code: linkSafety.warningCode ?? "unsafe-url-dropped",
        message: "Dropped text_link entity with unsafe or invalid URL.",
        source: "normalizer",
        entityType: entity.type,
        reason: linkSafety.reason,
        value: linkSafety.redactedValue,
      });
      return null;
    }
    return { ...entity, url: entity.url };
  }

  if (entity.type === "pre") {
    const language = sanitizeTelegramPreLanguage(entity.language);
    if (entity.language && !language) {
      pushTelegramRenderWarning(warnings, structuredWarnings, {
        code: "pre-language-sanitized",
        message: "Dropped unsafe Telegram pre language token.",
        source: "normalizer",
        entityType: entity.type,
        value: "[removed]",
      });
    }
    return {
      type: entity.type,
      offset: entity.offset,
      length: entity.length,
      ...(language ? { language } : {}),
    };
  }

  return {
    type: entity.type,
    offset: entity.offset,
    length: entity.length,
  };
}

function sortEntities<T extends IndexedEntity>(entities: T[]): T[] {
  return [...entities].sort((left, right) => {
    if (left.offset !== right.offset) {
      return left.offset - right.offset;
    }
    if (left.length !== right.length) {
      return right.length - left.length;
    }
    return left.originalIndex - right.originalIndex;
  });
}

function removeCodeAndPreFormattingConflicts(
  entities: IndexedEntity[],
  warnings: string[],
  structuredWarnings: TelegramRenderWarning[],
): IndexedEntity[] {
  const codeRanges = entities.filter((entity) => CODE_ENTITY_TYPES.has(entity.type));
  if (codeRanges.length === 0) {
    return entities;
  }

  return entities.filter((entity) => {
    if (CODE_ENTITY_TYPES.has(entity.type)) {
      return true;
    }
    const conflictsWithCode = codeRanges.some((codeEntity) => rangesOverlap(entity, codeEntity));
    if (conflictsWithCode) {
      pushTelegramRenderWarning(warnings, structuredWarnings, {
        code: "code-formatting-dropped",
        message: `Dropped ${entity.type} entity overlapping code/pre text.`,
        source: "normalizer",
        entityType: entity.type,
      });
      return false;
    }
    return true;
  });
}

function removeNestedBlockquotes(
  entities: IndexedEntity[],
  warnings: string[],
  structuredWarnings: TelegramRenderWarning[],
): IndexedEntity[] {
  const acceptedBlockquotes: IndexedEntity[] = [];
  return entities.filter((entity) => {
    if (!BLOCKQUOTE_ENTITY_TYPES.has(entity.type)) {
      return true;
    }

    const nested = acceptedBlockquotes.some(
      (accepted) => rangeContains(accepted, entity) || rangeContains(entity, accepted),
    );
    if (nested) {
      pushTelegramRenderWarning(warnings, structuredWarnings, {
        code: "nested-blockquote-dropped",
        message: "Dropped nested Telegram blockquote entity.",
        source: "normalizer",
        entityType: entity.type,
      });
      return false;
    }

    acceptedBlockquotes.push(entity);
    return true;
  });
}

function removePartialOverlaps(
  entities: IndexedEntity[],
  warnings: string[],
  structuredWarnings: TelegramRenderWarning[],
): IndexedEntity[] {
  const accepted: IndexedEntity[] = [];
  for (const entity of entities) {
    const partialOverlap = accepted.some((existing) => rangesPartiallyOverlap(existing, entity));
    if (partialOverlap) {
      pushTelegramRenderWarning(warnings, structuredWarnings, {
        code: "partial-overlap-dropped",
        message: `Dropped ${entity.type} entity with partial overlap.`,
        source: "normalizer",
        entityType: entity.type,
      });
      continue;
    }
    accepted.push(entity);
  }
  return accepted;
}

export function normalizeTelegramEntities(
  text: string,
  entities: readonly TelegramMessageEntity[],
): TelegramEntityValidationResult {
  const warnings: string[] = [];
  const structuredWarnings: TelegramRenderWarning[] = [];
  const normalized = entities.reduce<IndexedEntity[]>((acc, entity, originalIndex) => {
    const rangeIsValid =
      Number.isInteger(entity.offset)
      && Number.isInteger(entity.length)
      && entity.offset >= 0
      && entity.length > 0
      && entityEnd(entity) <= text.length;
    if (!rangeIsValid) {
      pushTelegramRenderWarning(warnings, structuredWarnings, {
        code: "entity-invalid-range-dropped",
        message: `Dropped ${entity.type} entity with invalid range.`,
        source: "normalizer",
        entityType: entity.type,
      });
      return acc;
    }

    const metadataNormalized = normalizeEntityMetadata(entity, warnings, structuredWarnings);
    if (!metadataNormalized) {
      return acc;
    }

    const rangeTrimmed = trimEntityRange(text, metadataNormalized);
    if (!rangeTrimmed) {
      pushTelegramRenderWarning(warnings, structuredWarnings, {
        code: "entity-empty-after-trim-dropped",
        message: `Dropped ${entity.type} entity after trailing whitespace trim.`,
        source: "normalizer",
        entityType: entity.type,
      });
      return acc;
    }
    if (rangeTrimmed.length !== metadataNormalized.length) {
      pushTelegramRenderWarning(warnings, structuredWarnings, {
        code: "entity-trimmed",
        message: `Trimmed trailing whitespace from ${entity.type} entity.`,
        source: "normalizer",
        entityType: entity.type,
      });
    }

    acc.push({ ...rangeTrimmed, originalIndex });
    return acc;
  }, []);

  const sorted = sortEntities(normalized);
  const withoutCodeConflicts = removeCodeAndPreFormattingConflicts(
    sorted,
    warnings,
    structuredWarnings,
  );
  const withoutNestedBlockquotes = removeNestedBlockquotes(
    withoutCodeConflicts,
    warnings,
    structuredWarnings,
  );
  const withoutPartialOverlaps = removePartialOverlaps(
    withoutNestedBlockquotes,
    warnings,
    structuredWarnings,
  );
  const finalEntities = sortEntities(withoutPartialOverlaps).map(({ originalIndex: _originalIndex, ...entity }) => entity);

  return {
    text,
    entities: finalEntities,
    warnings,
    structuredWarnings,
  };
}

export class TelegramTextBuilder {
  private textValue = "";
  private readonly entityValue: TelegramMessageEntity[] = [];

  get length(): number {
    return this.textValue.length;
  }

  append(text: string | undefined | null): void {
    if (text) {
      this.textValue += text;
    }
  }

  addEntity(
    type: TelegramMessageEntityType,
    offset: number,
    length: number,
    metadata: Pick<TelegramMessageEntity, "url" | "language"> = {},
  ): void {
    if (length <= 0) {
      return;
    }
    this.entityValue.push({
      type,
      offset,
      length,
      ...(metadata.url ? { url: metadata.url } : {}),
      ...(metadata.language ? { language: metadata.language } : {}),
    });
  }

  withEntity(
    type: TelegramMessageEntityType,
    render: () => void,
    metadata: Pick<TelegramMessageEntity, "url" | "language"> = {},
  ): void {
    const offset = this.length;
    render();
    this.addEntity(type, offset, this.length - offset, metadata);
  }

  toRenderedMessage(
    warnings: readonly string[] = [],
    structuredWarnings: readonly TelegramRenderWarning[] = [],
  ): TelegramRenderedMessage {
    const normalized = normalizeTelegramEntities(this.textValue, this.entityValue);
    return {
      text: normalized.text,
      entities: normalized.entities,
      warnings: [...warnings, ...normalized.warnings],
      structuredWarnings: [
        ...structuredWarnings,
        ...normalized.structuredWarnings,
      ],
    };
  }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

export function isUtf16Boundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return true;
  }
  return !(
    isHighSurrogate(text.charCodeAt(index - 1))
    && isLowSurrogate(text.charCodeAt(index))
  );
}

export function clampToUtf16Boundary(text: string, index: number): number {
  let safeIndex = Math.max(0, Math.min(index, text.length));
  if (!isUtf16Boundary(text, safeIndex)) {
    safeIndex -= 1;
  }
  return safeIndex;
}

function truncateRenderedMessageForTelegram(
  rendered: TelegramRenderedMessage,
  maxLength: number,
  markerOverheadPerFullMessage = 0,
): TelegramRenderedMessage {
  const maxTotalLength = Math.max(
    maxLength,
    maxLength * TELEGRAM_MESSAGE_MAX_CHUNKS - markerOverheadPerFullMessage,
  );
  if (rendered.text.length <= maxTotalLength) {
    return rendered;
  }

  const textBudget = Math.max(0, maxTotalLength - TELEGRAM_TRUNCATION_NOTICE.length);
  const truncatedEnd = clampToUtf16Boundary(rendered.text, textBudget);
  return {
    text: `${rendered.text.slice(0, truncatedEnd)}${TELEGRAM_TRUNCATION_NOTICE}`,
    entities: rendered.entities,
    warnings: [
      ...rendered.warnings,
      `Telegram message truncated to ${TELEGRAM_MESSAGE_MAX_CHUNKS} chunks.`,
    ],
    structuredWarnings: [
      ...(rendered.structuredWarnings ?? []),
      {
        code: "message-truncated",
        message: `Telegram message truncated to ${TELEGRAM_MESSAGE_MAX_CHUNKS} chunks.`,
        source: "chunker",
      },
    ],
  };
}

function normalizeChunkingOptions(options: TelegramChunkingOptions): Required<TelegramChunkingOptions> {
  return {
    continuationMarkers: options.continuationMarkers !== false,
    continuationPrefix: options.continuationPrefix ?? TELEGRAM_CONTINUATION_PREFIX,
    continuationSuffix: options.continuationSuffix ?? TELEGRAM_CONTINUATION_SUFFIX,
  };
}

function markerOverheadForMaxChunks(options: Required<TelegramChunkingOptions>): number {
  if (!options.continuationMarkers) {
    return 0;
  }
  return (TELEGRAM_MESSAGE_MAX_CHUNKS - 1)
    * (options.continuationPrefix.length + options.continuationSuffix.length);
}

function lastIndexAtOrBefore(text: string, search: string, start: number, end: number): number {
  const index = text.lastIndexOf(search, end - 1);
  return index >= start ? index : -1;
}

function findNaturalSplit(text: string, start: number, hardEnd: number): number {
  const paragraph = lastIndexAtOrBefore(text, "\n\n", start + 1, hardEnd);
  if (paragraph > start) {
    return paragraph + 2;
  }

  const newline = lastIndexAtOrBefore(text, "\n", start + 1, hardEnd);
  if (newline > start) {
    return newline + 1;
  }

  const space = lastIndexAtOrBefore(text, " ", start + 1, hardEnd);
  if (space > start) {
    return space + 1;
  }

  return hardEnd;
}

function avoidNonSplittableEntityBoundary(
  entities: readonly TelegramMessageEntity[],
  start: number,
  proposedEnd: number,
): number {
  for (const entity of entities) {
    if (!NON_SPLITTABLE_ENTITY_TYPES.has(entity.type)) {
      continue;
    }
    if (entity.offset < proposedEnd && entityEnd(entity) > proposedEnd && entity.offset > start) {
      return entity.offset;
    }
  }
  return proposedEnd;
}

function remapEntitiesForChunk(
  entities: readonly TelegramMessageEntity[],
  start: number,
  end: number,
  offsetDelta = 0,
): TelegramMessageEntity[] {
  return entities.reduce<TelegramMessageEntity[]>((acc, entity) => {
    const overlapStart = Math.max(start, entity.offset);
    const overlapEnd = Math.min(end, entityEnd(entity));
    if (overlapEnd <= overlapStart) {
      return acc;
    }

    acc.push({
      ...entity,
      offset: overlapStart - start + offsetDelta,
      length: overlapEnd - overlapStart,
    });
    return acc;
  }, []);
}

export function splitTelegramRenderedMessage(
  rendered: TelegramRenderedMessage,
  maxLength = TELEGRAM_MESSAGE_MAX_LENGTH,
  options: TelegramChunkingOptions = {},
): TelegramRenderedMessage[] {
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new Error("maxLength must be a positive integer");
  }

  const markerOptions = normalizeChunkingOptions(options);
  const markersFit =
    markerOptions.continuationPrefix.length + markerOptions.continuationSuffix.length < maxLength;
  const markersEnabled = markerOptions.continuationMarkers && markersFit;
  const bounded = truncateRenderedMessageForTelegram(
    rendered,
    maxLength,
    markersEnabled ? markerOverheadForMaxChunks(markerOptions) : 0,
  );
  const normalized = normalizeTelegramEntities(bounded.text, bounded.entities);
  const warnings = [...bounded.warnings, ...normalized.warnings];
  const structuredWarnings = [
    ...(bounded.structuredWarnings ?? []),
    ...normalized.structuredWarnings,
  ];
  if (normalized.text.length <= maxLength) {
    return [{
      text: normalized.text,
      entities: normalized.entities,
      warnings,
      structuredWarnings,
    }];
  }

  const chunks: TelegramRenderedMessage[] = [];
  let start = 0;

  while (start < normalized.text.length) {
    const prefix = markersEnabled && chunks.length > 0
      ? markerOptions.continuationPrefix
      : "";
    const lastChunkBudget = maxLength - prefix.length;
    const remaining = normalized.text.length - start;
    const willFitLastChunk = remaining <= lastChunkBudget;
    const suffix = markersEnabled && !willFitLastChunk
      ? markerOptions.continuationSuffix
      : "";
    const contentBudget = Math.max(1, maxLength - prefix.length - suffix.length);
    let end = willFitLastChunk
      ? normalized.text.length
      : findNaturalSplit(
        normalized.text,
        start,
        clampToUtf16Boundary(normalized.text, start + contentBudget),
      );

    end = avoidNonSplittableEntityBoundary(normalized.entities, start, end);
    end = clampToUtf16Boundary(normalized.text, end);

    if (end <= start) {
      end = clampToUtf16Boundary(normalized.text, start + contentBudget);
    }
    if (end <= start) {
      end = Math.min(normalized.text.length, start + contentBudget);
    }

    const chunkText = `${prefix}${normalized.text.slice(start, end)}${suffix}`;
    const chunkEntities = remapEntitiesForChunk(
      normalized.entities,
      start,
      end,
      prefix.length,
    );
    const chunkNormalized = normalizeTelegramEntities(chunkText, chunkEntities);
    chunks.push({
      text: chunkNormalized.text,
      entities: chunkNormalized.entities,
      warnings: chunks.length === 0
        ? [...warnings, ...chunkNormalized.warnings]
        : chunkNormalized.warnings,
      structuredWarnings: chunks.length === 0
        ? [...structuredWarnings, ...chunkNormalized.structuredWarnings]
        : chunkNormalized.structuredWarnings,
    });
    start = end;
  }

  return chunks;
}
