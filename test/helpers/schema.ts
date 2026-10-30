import { readFileSync } from "node:fs";
import { join } from "node:path";

// Minimal JSON Schema (draft-07 subset) for the --json schemas in test/schemas/: type (string or list,
// "integer"), enum, required, properties, additionalProperties (boolean or schema), items and local $ref.

type TSchema = { [key: string]: unknown };

export const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");

export function loadSchema(name: string): TSchema {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.json`), "utf8")) as TSchema;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return Number.isInteger(value);
  return typeOf(value) === type;
}

function resolveRef(root: TSchema, ref: string): TSchema {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref: ${ref}`);
  let node: unknown = root;
  for (const key of ref.slice(2).split("/")) {
    if (typeOf(node) !== "object" || !(key in (node as TSchema))) {
      throw new Error(`dangling $ref: ${ref}`);
    }
    node = (node as TSchema)[key];
  }
  return node as TSchema;
}

function check(
  root: TSchema,
  schema: TSchema,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (typeof schema.$ref === "string") {
    check(root, resolveRef(root, schema.$ref), value, path, errors);
    return;
  }
  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join("|")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in obj)) errors.push(`${path}: missing ${key}`);
    }
    const props = (schema.properties ?? {}) as Record<string, TSchema>;
    const additional = schema.additionalProperties;
    for (const [key, v] of Object.entries(obj)) {
      const prop = props[key];
      if (prop) check(root, prop, v, `${path}.${key}`, errors);
      else if (additional === false) errors.push(`${path}: unexpected key ${key}`);
      else if (typeOf(additional) === "object") {
        check(root, additional as TSchema, v, `${path}.${key}`, errors);
      }
    }
  }
  if (typeOf(value) === "array" && typeOf(schema.items) === "object") {
    (value as unknown[]).forEach((v, i) => {
      check(root, schema.items as TSchema, v, `${path}[${i}]`, errors);
    });
  }
}

export function validate(schema: TSchema, value: unknown): string[] {
  const errors: string[] = [];
  check(schema, schema, value, "$", errors);
  return errors;
}
