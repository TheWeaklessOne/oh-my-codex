import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type {
  Blockquote,
  Code,
  Content,
  Definition,
  Heading,
  Image,
  ImageReference,
  InlineCode,
  Link,
  LinkReference,
  List,
  ListItem,
  Nodes,
  Parent,
  PhrasingContent,
  Root,
  Table,
  TableCell,
} from "mdast";
import {
  classifyTelegramLinkUrl,
  type TelegramLinkSafetyResult,
  TelegramTextBuilder,
} from "./telegram-entities.js";
import type {
  TelegramMessageEntityType,
  TelegramRenderedMessage,
  TelegramRenderWarning,
} from "./types.js";

interface RenderContext {
  listDepth: number;
  inBlockquote: boolean;
  definitions: Map<string, Definition>;
  warnings: string[];
  structuredWarnings: TelegramRenderWarning[];
}

export interface TelegramMarkdownRenderOptions {
  tableMaxWidth?: number;
}

const DEFAULT_TABLE_MAX_WIDTH = 96;
export const TELEGRAM_TABLE_CARD_COLUMN_THRESHOLD = 4;
export const TELEGRAM_TABLE_CARD_TEXT_LENGTH_THRESHOLD = 700;
export const TELEGRAM_TABLE_CARD_ROW_SEPARATOR = "\n---\n";
const SPOILER_DELIMITER = "||";
const EXPANDABLE_BLOCKQUOTE_MARKER = "[!EXPANDABLE]";

function normalizeReferenceIdentifier(identifier: string | undefined): string {
  return (identifier ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
}

function collectDefinitions(ast: Root): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  for (const child of ast.children) {
    if (child.type === "definition") {
      definitions.set(normalizeReferenceIdentifier(child.identifier), child);
    }
  }
  return definitions;
}

function baseContext(definitions: Map<string, Definition>): RenderContext {
  return {
    listDepth: 0,
    inBlockquote: false,
    definitions,
    warnings: [],
    structuredWarnings: [],
  };
}

function childContext(
  context: RenderContext,
  overrides: Partial<Pick<RenderContext, "listDepth" | "inBlockquote">> = {},
): RenderContext {
  return {
    ...context,
    ...overrides,
  };
}

function pushRendererWarning(
  context: RenderContext,
  warning: TelegramRenderWarning,
): void {
  context.warnings.push(warning.message);
  context.structuredWarnings.push(warning);
}

function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

function hasChildren(node: Nodes): boolean {
  return Array.isArray((node as Parent).children);
}

function nodeChildren(node: Nodes): Content[] {
  return hasChildren(node) ? (node as Parent).children as Content[] : [];
}

function appendBlockSeparator(builder: TelegramTextBuilder): void {
  if (builder.length === 0) {
    return;
  }
  builder.append("\n\n");
}

function renderChildren(
  builder: TelegramTextBuilder,
  children: readonly Content[],
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  const renderableChildren = children.filter((child) => child.type !== "definition");
  renderableChildren.forEach((child, index) => {
    if (index > 0) {
      appendBlockSeparator(builder);
    }
    renderBlock(builder, child, context, options);
  });
}

function renderBlock(
  builder: TelegramTextBuilder,
  node: Content,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  switch (node.type) {
    case "paragraph":
      renderPhrasingChildren(builder, node, context, options);
      break;
    case "heading":
      renderHeading(builder, node, context, options);
      break;
    case "code":
      renderCodeBlock(builder, node);
      break;
    case "list":
      renderList(builder, node, context, options);
      break;
    case "blockquote":
      renderBlockquote(builder, node, context, options);
      break;
    case "table":
      renderTable(builder, node, context, options);
      break;
    case "thematicBreak":
      builder.append("---");
      break;
    case "html":
      renderHtml(builder, node.value, context);
      break;
    case "definition":
      break;
    default:
      renderUnknownNode(builder, node, context, options);
      break;
  }
}

function renderPhrasingChildren(
  builder: TelegramTextBuilder,
  node: Parent,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  for (const child of node.children as Content[]) {
    renderPhrasing(builder, child, context, options);
  }
}

function renderPhrasing(
  builder: TelegramTextBuilder,
  node: Content,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  switch (node.type) {
    case "text":
      renderTextWithSpoilers(builder, node.value);
      break;
    case "emphasis":
      renderFormatting(builder, "italic", node, context, options);
      break;
    case "strong":
      renderFormatting(builder, "bold", node, context, options);
      break;
    case "delete":
      renderFormatting(builder, "strikethrough", node, context, options);
      break;
    case "inlineCode":
      renderInlineCode(builder, node);
      break;
    case "break":
      builder.append("\n");
      break;
    case "link":
      renderLink(builder, node, context, options);
      break;
    case "linkReference":
      renderLinkReference(builder, node, context, options);
      break;
    case "image":
      renderImage(builder, node, context);
      break;
    case "imageReference":
      renderImageReference(builder, node, context);
      break;
    case "html":
      renderHtml(builder, node.value, context);
      break;
    default:
      renderUnknownPhrasingNode(builder, node, context, options);
      break;
  }
}

function pushUnsupportedNodeWarning(
  context: RenderContext,
  node: Nodes,
): void {
  pushRendererWarning(context, {
    code: "unsupported-node-degraded",
    message: `Degraded unsupported Markdown node "${node.type}" to safe plain text.`,
    source: "renderer",
    nodeType: node.type,
  });
}

function renderUnknownPhrasingNode(
  builder: TelegramTextBuilder,
  node: Content,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  pushUnsupportedNodeWarning(context, node);
  if (hasChildren(node)) {
    renderPhrasingChildren(builder, node as Parent, context, options);
    return;
  }
  if ("value" in node && typeof node.value === "string") {
    builder.append(node.value);
    return;
  }

  const fallbackLabel = (node as { label?: unknown; identifier?: unknown }).label
    ?? (node as { label?: unknown; identifier?: unknown }).identifier;
  if (typeof fallbackLabel === "string" && fallbackLabel.trim()) {
    builder.append(`[${fallbackLabel.trim()}]`);
  }
}

function renderTextWithSpoilers(builder: TelegramTextBuilder, value: string): void {
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf(SPOILER_DELIMITER, cursor);
    if (open < 0) {
      builder.append(value.slice(cursor));
      return;
    }

    const close = value.indexOf(SPOILER_DELIMITER, open + SPOILER_DELIMITER.length);
    if (close < 0) {
      builder.append(value.slice(cursor));
      return;
    }

    builder.append(value.slice(cursor, open));
    const spoilerText = value.slice(open + SPOILER_DELIMITER.length, close);
    if (spoilerText.length > 0) {
      builder.withEntity("spoiler", () => {
        builder.append(spoilerText);
      });
    }
    cursor = close + SPOILER_DELIMITER.length;
  }
}

function renderFormatting(
  builder: TelegramTextBuilder,
  type: "bold" | "italic" | "strikethrough",
  node: Parent,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  builder.withEntity(type, () => {
    renderPhrasingChildren(builder, node, context, options);
  });
}

function renderHeading(
  builder: TelegramTextBuilder,
  node: Heading,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  builder.withEntity("bold", () => {
    renderPhrasingChildren(builder, node, context, options);
  });
}

function renderInlineCode(builder: TelegramTextBuilder, node: InlineCode): void {
  builder.withEntity("code", () => {
    builder.append(node.value);
  });
}

function renderCodeBlock(builder: TelegramTextBuilder, node: Code): void {
  builder.withEntity(
    "pre",
    () => {
      builder.append(node.value);
    },
    node.lang ? { language: node.lang } : {},
  );
}

function addSafeTextLinkEntity(
  builder: TelegramTextBuilder,
  start: number,
  url: string,
): void {
  builder.addEntity("text_link", start, builder.length - start, { url });
}

function pushDroppedLinkWarning(
  context: RenderContext,
  linkSafety: TelegramLinkSafetyResult,
): void {
  if (linkSafety.safe) {
    return;
  }

  pushRendererWarning(context, {
    code: linkSafety.warningCode ?? "unsafe-url-dropped",
    message: "Dropped unsafe Telegram link URL.",
    source: "renderer",
    reason: linkSafety.reason,
    value: linkSafety.redactedValue,
  });
}

function renderLink(
  builder: TelegramTextBuilder,
  node: Link,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  const linkSafety = classifyTelegramLinkUrl(node.url);
  const start = builder.length;
  if (node.children.length > 0) {
    renderPhrasingChildren(builder, node, context, options);
  } else if (linkSafety.safe) {
    builder.append(node.url);
  } else {
    builder.append("link");
  }

  if (linkSafety.safe) {
    addSafeTextLinkEntity(builder, start, node.url);
    return;
  }

  pushDroppedLinkWarning(context, linkSafety);
}

function renderLinkReference(
  builder: TelegramTextBuilder,
  node: LinkReference,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  const definition = context.definitions.get(
    normalizeReferenceIdentifier(node.identifier),
  );
  const start = builder.length;
  if (node.children.length > 0) {
    renderPhrasingChildren(builder, node, context, options);
  } else {
    builder.append(node.label || node.identifier);
  }

  if (!definition) {
    return;
  }

  const linkSafety = classifyTelegramLinkUrl(definition.url);
  if (linkSafety.safe) {
    addSafeTextLinkEntity(builder, start, definition.url);
    return;
  }

  pushDroppedLinkWarning(context, linkSafety);
  // Reference definitions are metadata, not visible Markdown content. If the
  // referenced URL is unsafe for a hidden Telegram text_link, keep only the
  // visible link label instead of surfacing hidden definition data.
}

function renderImage(
  builder: TelegramTextBuilder,
  node: Image,
  context: RenderContext,
): void {
  pushRendererWarning(context, {
    code: "image-degraded",
    message: "Degraded image Markdown to safe plain text.",
    source: "renderer",
    nodeType: "image",
  });
  const label = node.alt?.trim() || "image";
  builder.append(label);
}

function renderImageReference(
  builder: TelegramTextBuilder,
  node: ImageReference,
  context: RenderContext,
): void {
  pushRendererWarning(context, {
    code: "image-degraded",
    message: "Degraded image reference Markdown to safe plain text.",
    source: "renderer",
    nodeType: "imageReference",
  });
  builder.append(node.alt?.trim() || node.label || node.identifier || "image");
}

function listMarker(node: List, item: ListItem, itemIndex: number): string {
  const taskPrefix = typeof item.checked === "boolean"
    ? `${item.checked ? "☑" : "☐"} `
    : "";
  if (node.ordered) {
    const start = typeof node.start === "number" ? node.start : 1;
    return `${start + itemIndex}. ${taskPrefix}`;
  }
  return `- ${taskPrefix}`;
}

function renderList(
  builder: TelegramTextBuilder,
  node: List,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  node.children.forEach((item, index) => {
    if (index > 0) {
      builder.append("\n");
    }
    const indent = "  ".repeat(context.listDepth);
    builder.append(indent);
    builder.append(listMarker(node, item, index));
    renderListItem(
      builder,
      item,
      childContext(context, { listDepth: context.listDepth + 1 }),
      options,
    );
  });
}

function renderListItem(
  builder: TelegramTextBuilder,
  item: ListItem,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  item.children.forEach((child, index) => {
    if (index > 0) {
      builder.append("\n");
      if (child.type !== "list") {
        builder.append("  ".repeat(context.listDepth));
      }
    }

    if (child.type === "paragraph") {
      renderPhrasingChildren(builder, child, context, options);
    } else if (child.type === "list") {
      renderList(builder, child, context, options);
    } else {
      renderBlock(builder, child, context, options);
    }
  });
}

function renderBlockquote(
  builder: TelegramTextBuilder,
  node: Blockquote,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  if (context.inBlockquote) {
    pushRendererWarning(context, {
      code: "nested-blockquote-dropped",
      message: "Dropped nested Telegram blockquote entity.",
      source: "renderer",
      nodeType: "blockquote",
    });
    renderChildren(builder, node.children, context, options);
    return;
  }

  const { entityType, children } = extractExpandableBlockquote(node);
  builder.withEntity(entityType, () => {
    renderChildren(
      builder,
      children,
      childContext(context, { inBlockquote: true }),
      options,
    );
  });
}

function extractExpandableBlockquote(node: Blockquote): {
  entityType: Extract<TelegramMessageEntityType, "blockquote" | "expandable_blockquote">;
  children: Content[];
} {
  const [first, ...rest] = node.children;
  if (!first || first.type !== "paragraph" || first.children.length === 0) {
    return { entityType: "blockquote", children: [...node.children] };
  }

  const [firstChild, ...remainingParagraphChildren] = first.children as PhrasingContent[];
  if (
    !firstChild
    || firstChild.type !== "text"
    || !firstChild.value.trimStart().startsWith(EXPANDABLE_BLOCKQUOTE_MARKER)
  ) {
    return { entityType: "blockquote", children: [...node.children] };
  }

  const leadingTrimmed = firstChild.value.trimStart();
  const markerStart = firstChild.value.length - leadingTrimmed.length;
  const afterMarker = firstChild.value
    .slice(markerStart + EXPANDABLE_BLOCKQUOTE_MARKER.length)
    .replace(/^[ \t]*\n?/u, "");
  const paragraphChildren: PhrasingContent[] = [
    ...(afterMarker ? [{ ...firstChild, value: afterMarker }] : []),
    ...remainingParagraphChildren,
  ];
  const children = paragraphChildren.length > 0
    ? [{ ...first, children: paragraphChildren }]
    : [...rest];
  if (paragraphChildren.length > 0) {
    children.push(...rest);
  }

  return {
    entityType: "expandable_blockquote",
    children,
  };
}

function plainTextFromNode(node: Nodes, context?: RenderContext): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value;
    case "html":
      if (context) {
        pushRendererWarning(context, {
          code: "raw-html-degraded",
          message: "Degraded raw HTML Markdown to safe plain text.",
          source: "renderer",
          nodeType: "html",
        });
      }
      return stripHtmlToPlainText(node.value);
    case "break":
      return "\n";
    case "image":
      if (context) {
        pushRendererWarning(context, {
          code: "image-degraded",
          message: "Degraded image Markdown to safe plain text.",
          source: "renderer",
          nodeType: "image",
        });
      }
      return node.alt || "image";
    case "link": {
      const linkSafety = classifyTelegramLinkUrl(node.url);
      if (!linkSafety.safe && context) {
        pushDroppedLinkWarning(context, linkSafety);
      }
      return node.children.map((child) => plainTextFromNode(child, context)).join("")
        || (linkSafety.safe ? node.url : "link");
    }
    default:
      return nodeChildren(node).map((child) => plainTextFromNode(child, context)).join("");
  }
}

function renderTable(
  builder: TelegramTextBuilder,
  node: Table,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  const rows = node.children.map((row) => row.children.map((cell) => plainTextFromCell(
    cell,
    context,
  )));
  if (rows.length === 0) {
    return;
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_unused, columnIndex) => Math.max(
    1,
    ...rows.map((row) => row[columnIndex]?.length ?? 0),
  ));

  const alignedRows = rows.map((row) => widths
    .map((width, columnIndex) => (row[columnIndex] ?? "").padEnd(width, " "))
    .join(" | ")
    .trimEnd());
  const tableText = alignedRows.join("\n");
  const shouldRenderCards =
    columnCount > TELEGRAM_TABLE_CARD_COLUMN_THRESHOLD
    || alignedRows.some((row) => row.length > options.tableMaxWidth)
    || tableText.length > TELEGRAM_TABLE_CARD_TEXT_LENGTH_THRESHOLD;

  if (shouldRenderCards) {
    pushRendererWarning(context, {
      code: "table-rendered-as-cards",
      message: "Rendered wide Markdown table as mobile-friendly cards.",
      source: "renderer",
      nodeType: "table",
      reason: `columns=${columnCount}; length=${tableText.length}; maxWidth=${options.tableMaxWidth}`,
    });
    builder.append(renderTableCards(rows));
    return;
  }

  builder.withEntity("pre", () => {
    builder.append(tableText);
  });
}

function plainTextFromCell(cell: TableCell, context: RenderContext): string {
  return cell.children
    .map((child) => plainTextFromNode(child, context))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function renderTableCards(rows: string[][]): string {
  const [header, ...bodyRows] = rows;
  if (!header || bodyRows.length === 0) {
    return rows.map((row) => row.join(" | ")).join("\n");
  }

  return bodyRows
    .map((row) => header
      .map((heading, index) => {
        const key = heading || `Column ${index + 1}`;
        const value = row[index]?.trim() || "—";
        return `${key}: ${value}`;
      })
      .join("\n"))
    .join(TELEGRAM_TABLE_CARD_ROW_SEPARATOR);
}

function renderHtml(
  builder: TelegramTextBuilder,
  html: string,
  context: RenderContext,
): void {
  pushRendererWarning(context, {
    code: "raw-html-degraded",
    message: "Degraded raw HTML Markdown to safe plain text.",
    source: "renderer",
    nodeType: "html",
  });
  const stripped = stripHtmlToPlainText(html);
  if (stripped) {
    builder.append(stripped);
  }
}

function stripHtmlToPlainText(html: string): string {
  return html.replace(/<[^>]*>/gu, "").trim();
}

function renderUnknownNode(
  builder: TelegramTextBuilder,
  node: Content,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  pushUnsupportedNodeWarning(context, node);
  if (hasChildren(node)) {
    renderChildren(builder, nodeChildren(node), context, options);
    return;
  }
  if ("value" in node && typeof node.value === "string") {
    builder.append(node.value);
  }
}

export function renderMarkdownToTelegramEntities(
  markdown: string,
  options: TelegramMarkdownRenderOptions = {},
): TelegramRenderedMessage {
  const normalizedOptions: Required<TelegramMarkdownRenderOptions> = {
    tableMaxWidth: options.tableMaxWidth ?? DEFAULT_TABLE_MAX_WIDTH,
  };

  try {
    const ast = parseMarkdown(markdown);
    const builder = new TelegramTextBuilder();
    const context = baseContext(collectDefinitions(ast));
    renderChildren(
      builder,
      ast.children,
      context,
      normalizedOptions,
    );
    return builder.toRenderedMessage(context.warnings, context.structuredWarnings);
  } catch (error) {
    const message = `Telegram Markdown renderer fallback: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return {
      text: markdown,
      entities: [],
      warnings: [message],
      structuredWarnings: [{
        code: "markdown-render-fallback",
        message,
        source: "renderer",
        reason: error instanceof Error ? error.name : typeof error,
      }],
    };
  }
}
