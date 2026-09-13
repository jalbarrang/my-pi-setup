/**
 * MCP tools ship plain JSON Schema. pi hands tool parameters to TypeBox's
 * `Value.Check`/`Value.Convert` for validation, which supports most of JSON
 * Schema but rejects some constructs (string `format` assertions, OpenAPI
 * `nullable`). This module keeps the schema faithful for the model while
 * normalizing the few keywords that would cause false validation failures.
 */

import type { TSchema } from "typebox";

type JsonObject = Record<string, unknown>;

const DROPPED_KEYS = new Set(["$schema", "$id", "$comment", "format", "discriminator", "examples"]);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizePropertyMap(value: unknown): JsonObject {
  const out: JsonObject = {};
  if (!isJsonObject(value)) return out;

  for (const [key, child] of Object.entries(value)) {
    out[key] = sanitizeSchema(child);
  }
  return out;
}

function sanitizeList(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((child) => sanitizeSchema(child));
}

/** Rewrite `nullable: true` into a type union TypeBox understands. */
function applyNullable(schema: JsonObject): JsonObject {
  if (schema.nullable !== true) return schema;

  const { nullable: _nullable, ...rest } = schema;
  if (typeof rest.type === "string") {
    return { ...rest, type: [rest.type, "null"] };
  }
  if (Array.isArray(rest.type) && !rest.type.includes("null")) {
    return { ...rest, type: [...rest.type, "null"] };
  }
  const variants = (rest.anyOf ?? rest.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) {
    const key = rest.anyOf ? "anyOf" : "oneOf";
    return { ...rest, [key]: [...variants, { type: "null" }] };
  }
  return rest;
}

function sanitizeSchema(value: unknown): unknown {
  if (!isJsonObject(value)) return value;

  const object: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key) || key === "nullable") continue;
    object[key] = sanitizeSchema(child);
  }

  if (isJsonObject(value.properties)) {
    object.properties = sanitizePropertyMap(value.properties);
  }
  if (value.items !== undefined) {
    object.items = sanitizeSchema(value.items);
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"] as const) {
    const list = sanitizeList(value[key]);
    if (list) object[key] = list;
  }
  if (isJsonObject(value.$defs)) {
    object.$defs = sanitizePropertyMap(value.$defs);
  }
  if (isJsonObject(value.definitions)) {
    object.definitions = sanitizePropertyMap(value.definitions);
  }
  if (isJsonObject(value.additionalProperties)) {
    object.additionalProperties = sanitizeSchema(value.additionalProperties);
  }

  return applyNullable(object);
}

/** Convert an MCP tool `inputSchema` into parameters pi can validate and expose. */
export function toToolParameters(inputSchema: unknown): TSchema {
  const sanitized = sanitizeSchema(inputSchema);
  const base = isJsonObject(sanitized) ? sanitized : {};

  return {
    ...base,
    type: "object",
    properties: isJsonObject(base.properties) ? base.properties : {},
  } as TSchema;
}
