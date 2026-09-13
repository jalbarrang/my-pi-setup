/**
 * Conversion of MCP tool/resource/prompt results into pi tool result content.
 *
 * MCP results are a list of content blocks (text, image, audio, embedded
 * resource). pi accepts text and image blocks, so images are attached inline
 * and everything else is flattened into text with explicit notes for anything
 * that had to be dropped.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { McpCallToolResult, McpGetPromptResult, McpReadResourceResult } from "./client.ts";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

export type ResultPart = TextPart | ImagePart;

export interface FormattedResult {
  parts: ResultPart[];
  /** Plain text form, useful for error messages and `/mcp logs`. */
  text: string;
  truncated: boolean;
}

/** Skip images larger than this (decoded bytes) instead of flooding the context. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function base64Size(value: string): number {
  const trimmed = value.replace(/\s/g, "");
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

function truncate(text: string): { text: string; truncated: boolean } {
  const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!result.truncated) return { text: result.content, truncated: false };

  return {
    text:
      `${result.content}\n\n[MCP output truncated: ${result.outputLines} of ${result.totalLines} lines ` +
      `(${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)})]`,
    truncated: true,
  };
}

function buildParts(textChunks: string[], images: ImagePart[]): FormattedResult {
  const joined = textChunks.filter((chunk) => chunk.trim().length > 0).join("\n\n");
  const { text, truncated } = truncate(joined);

  const parts: ResultPart[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  parts.push(...images);

  return { parts, text, truncated };
}

/** Format a `tools/call` result block list. */
export function formatCallToolResult(result: McpCallToolResult): FormattedResult {
  const text: string[] = [];
  const images: ImagePart[] = [];

  for (const block of result.content) {
    switch (block.type) {
      case "text":
        text.push(block.text);
        break;
      case "image": {
        const size = base64Size(block.data);
        if (size > MAX_IMAGE_BYTES) {
          text.push(`[MCP image omitted: ${block.mimeType}, ${formatSize(size)} exceeds ${formatSize(MAX_IMAGE_BYTES)}]`);
          break;
        }
        images.push({ type: "image", data: block.data, mimeType: block.mimeType });
        break;
      }
      case "audio":
        text.push(`[MCP audio content omitted: ${block.mimeType}, ${formatSize(base64Size(block.data))}]`);
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource && typeof resource.text === "string") {
          text.push(`Resource: ${resource.uri}\n${resource.text}`);
          break;
        }
        const blob = "blob" in resource ? resource.blob : undefined;
        const mime = resource.mimeType ?? "application/octet-stream";
        if (typeof blob !== "string") {
          text.push(`[MCP resource without text or blob: ${resource.uri}]`);
          break;
        }
        const size = base64Size(blob);
        if (isImageMime(mime) && size <= MAX_IMAGE_BYTES) {
          images.push({ type: "image", data: blob, mimeType: mime });
          text.push(`MCP image resource attached: ${resource.uri}`);
          break;
        }
        text.push(`[MCP binary resource omitted: ${resource.uri} (${mime}, ${formatSize(size)})]`);
        break;
      }
      case "resource_link": {
        const label = block.title ? `${block.title} <${block.uri}>` : block.uri;
        text.push(`MCP resource link: ${label}${block.description ? ` — ${block.description}` : ""}`);
        break;
      }
      default:
        text.push(`[Unsupported MCP content block: ${JSON.stringify(block)}]`);
    }
  }

  const structured = result.structuredContent;
  if (text.length === 0 && images.length === 0 && structured !== undefined && structured !== null) {
    text.push(JSON.stringify(structured, null, 2));
  }

  return buildParts(text, images);
}

/** Format a `resources/read` result. */
export function formatResourceResult(server: string, uri: string, result: McpReadResourceResult): FormattedResult {
  const text: string[] = [];
  const images: ImagePart[] = [];

  for (const item of result.contents) {
    const mime = item.mimeType ?? "text/plain";
    if ("text" in item && typeof item.text === "string") {
      text.push(`Resource: ${item.uri}\nMIME: ${mime}\n\n${item.text}`);
      continue;
    }
    const blob = "blob" in item ? item.blob : undefined;
    if (typeof blob !== "string") {
      text.push(`[MCP resource without text or blob: ${item.uri}]`);
      continue;
    }
    const size = base64Size(blob);
    if (isImageMime(mime) && size <= MAX_IMAGE_BYTES) {
      images.push({ type: "image", data: blob, mimeType: mime });
      text.push(`MCP image resource attached: ${item.uri}`);
      continue;
    }
    text.push(`[MCP binary resource omitted: ${item.uri} (${mime}, ${formatSize(size)})]`);
  }

  if (text.length === 0 && images.length === 0) {
    text.push(`MCP resource ${uri} from ${server} returned no contents.`);
  }

  return buildParts(text, images);
}

/** Format a `prompts/get` result as a text transcript. */
export function formatPromptResult(server: string, name: string, result: McpGetPromptResult): FormattedResult {
  const text: string[] = [];

  for (const message of result.messages) {
    const content = message.content;
    if (content.type === "text") {
      text.push(`## ${message.role}\n\n${content.text}`);
      continue;
    }
    if (content.type === "image") {
      text.push(`## ${message.role}\n\n[MCP image omitted from prompt: ${content.mimeType}]`);
      continue;
    }
    if (content.type === "resource") {
      const resource = content.resource;
      text.push(
        "text" in resource && typeof resource.text === "string"
          ? `## ${message.role}\n\nResource ${resource.uri}:\n\n${resource.text}`
          : `## ${message.role}\n\n[MCP binary resource omitted from prompt: ${resource.uri}]`,
      );
      continue;
    }
    text.push(`## ${message.role}\n\n[Unsupported MCP prompt content]`);
  }

  if (text.length === 0) text.push(`Prompt ${name} from ${server} returned no messages.`);
  return buildParts(text, []);
}
