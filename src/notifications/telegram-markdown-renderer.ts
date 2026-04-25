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
  Root,
  Table,
  TableCell,
} from "mdast";
import { isSafeTelegramLinkUrl, TelegramTextBuilder } from "./telegram-entities.js";
import type { TelegramRenderedMessage } from "./types.js";

interface RenderContext {
  listDepth: number;
  inBlockquote: boolean;
  definitions: Map<string, Definition>;
}

export interface TelegramMarkdownRenderOptions {
  tableMaxWidth?: number;
}

const DEFAULT_TABLE_MAX_WIDTH = 96;

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
  };
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
      renderTable(builder, node, options);
      break;
    case "thematicBreak":
      builder.append("---");
      break;
    case "html":
      renderHtml(builder, node.value);
      break;
    case "definition":
      break;
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
      builder.append(node.value);
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
      renderImage(builder, node);
      break;
    case "imageReference":
      renderImageReference(builder, node);
      break;
    case "html":
      renderHtml(builder, node.value);
      break;
    default:
      if (hasChildren(node)) {
        renderPhrasingChildren(builder, node as Parent, context, options);
      } else if ("value" in node && typeof node.value === "string") {
        builder.append(node.value);
      }
      break;
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
  url: string | undefined,
): boolean {
  if (!isSafeTelegramLinkUrl(url)) {
    return false;
  }

  builder.addEntity("text_link", start, builder.length - start, { url });
  return true;
}

function renderLink(
  builder: TelegramTextBuilder,
  node: Link,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  const start = builder.length;
  if (node.children.length > 0) {
    renderPhrasingChildren(builder, node, context, options);
  } else {
    builder.append(node.url);
  }

  if (addSafeTextLinkEntity(builder, start, node.url)) {
    return;
  }

  if (node.url) {
    builder.append(` (${node.url})`);
  }
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

  if (addSafeTextLinkEntity(builder, start, definition.url)) {
    return;
  }

  // Reference definitions are metadata, not visible Markdown content. If the
  // referenced URL is unsafe for a hidden Telegram text_link, keep only the
  // visible link label instead of surfacing hidden definition data.
}

function renderImage(builder: TelegramTextBuilder, node: Image): void {
  const label = node.alt?.trim() || "image";
  builder.append(label);
}

function renderImageReference(
  builder: TelegramTextBuilder,
  node: ImageReference,
): void {
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
    renderListItem(builder, item, { ...context, listDepth: context.listDepth + 1 }, options);
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
    renderChildren(builder, node.children, context, options);
    return;
  }

  builder.withEntity("blockquote", () => {
    renderChildren(
      builder,
      node.children,
      { ...context, inBlockquote: true },
      options,
    );
  });
}

function plainTextFromNode(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
    case "html":
      return node.value;
    case "break":
      return "\n";
    case "image":
      return node.alt || node.url;
    case "link":
      return node.children.map(plainTextFromNode).join("") || node.url;
    default:
      return nodeChildren(node).map(plainTextFromNode).join("");
  }
}

function renderTable(
  builder: TelegramTextBuilder,
  node: Table,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
  const rows = node.children.map((row) => row.children.map((cell) => plainTextFromCell(cell)));
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
  const tooWide = alignedRows.some((row) => row.length > options.tableMaxWidth);
  const tableText = tooWide ? renderNarrowTable(rows) : alignedRows.join("\n");

  builder.withEntity("pre", () => {
    builder.append(tableText);
  });
}

function plainTextFromCell(cell: TableCell): string {
  return cell.children.map(plainTextFromNode).join("").replace(/\s+/gu, " ").trim();
}

function renderNarrowTable(rows: string[][]): string {
  const [header, ...bodyRows] = rows;
  if (!header || bodyRows.length === 0) {
    return rows.map((row) => row.join(" | ")).join("\n");
  }

  return bodyRows
    .map((row) => header
      .map((heading, index) => `${heading || `Column ${index + 1}`}: ${row[index] ?? ""}`)
      .join("\n"))
    .join("\n\n");
}

function renderHtml(builder: TelegramTextBuilder, html: string): void {
  const stripped = html.replace(/<[^>]*>/gu, "").trim();
  if (stripped) {
    builder.append(stripped);
  }
}

function renderUnknownNode(
  builder: TelegramTextBuilder,
  node: Content,
  context: RenderContext,
  options: Required<TelegramMarkdownRenderOptions>,
): void {
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
    renderChildren(
      builder,
      ast.children,
      baseContext(collectDefinitions(ast)),
      normalizedOptions,
    );
    return builder.toRenderedMessage();
  } catch (error) {
    return {
      text: markdown,
      entities: [],
      warnings: [
        `Telegram Markdown renderer fallback: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
