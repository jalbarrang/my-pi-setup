#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [sharedPath, localPath, outputPath] = process.argv.slice(2);

if (!sharedPath || !localPath || !outputPath) {
  console.error(
    "Usage: node scripts/merge-settings.mjs <shared.json> <local.json> <output.json>",
  );
  process.exit(1);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeObjects(base, overlay) {
  const result = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    result[key] =
      isObject(result[key]) && isObject(value)
        ? mergeObjects(result[key], value)
        : structuredClone(value);
  }

  return result;
}

async function readJson(path, { optional = false } = {}) {
  try {
    const content = await readFile(path, "utf8");
    const value = JSON.parse(content);
    if (!isObject(value)) throw new Error("the root value must be an object");
    return value;
  } catch (error) {
    if (optional && error?.code === "ENOENT") return {};
    throw new Error(`Could not read ${path}: ${error.message}`, { cause: error });
  }
}

function packageIdentity(entry) {
  if (typeof entry === "string") return entry;
  if (isObject(entry) && typeof entry.source === "string") return entry.source;
  return JSON.stringify(entry);
}

function configuredPackages(shared, local) {
  const packages = [];
  const indexes = new Map();

  for (const entry of [...shared, ...local]) {
    const identity = packageIdentity(entry);
    const existingIndex = indexes.get(identity);

    if (existingIndex === undefined) {
      indexes.set(identity, packages.length);
      packages.push(entry);
    } else {
      packages[existingIndex] = entry;
    }
  }

  return { packages, identities: new Set(indexes.keys()) };
}

const [shared, local, existing] = await Promise.all([
  readJson(sharedPath),
  readJson(localPath, { optional: true }),
  readJson(outputPath, { optional: true }),
]);

const merged = mergeObjects(mergeObjects(existing, shared), local);
const sharedPackages = Array.isArray(shared.packages) ? shared.packages : [];
const localPackages = Array.isArray(local.packages) ? local.packages : [];
const existingPackages = Array.isArray(existing.packages) ? existing.packages : [];
const configured = configuredPackages(sharedPackages, localPackages);

merged.packages = [
  ...configured.packages,
  ...existingPackages.filter(
    (entry) => !configured.identities.has(packageIdentity(entry)),
  ),
];

await mkdir(dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.${process.pid}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(merged, null, 2)}\n`, {
  mode: 0o600,
});
await rename(temporaryPath, outputPath);
await chmod(outputPath, 0o600);
