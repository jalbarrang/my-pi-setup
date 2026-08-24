import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./merge-settings.mjs", import.meta.url));

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("merges shared settings, local overrides, and existing machine state", async () => {
  await withTempDirectory(async (directory) => {
    const sharedPath = join(directory, "shared.json");
    const localPath = join(directory, "local.json");
    const outputPath = join(directory, "settings.json");

    await writeJson(sharedPath, {
      theme: "dark",
      compaction: { enabled: true },
      packages: [
        "npm:shared",
        { source: "npm:filtered", extensions: ["-extensions/unused.ts"] },
      ],
    });
    await writeJson(localPath, {
      theme: "light",
      packages: ["npm:filtered", "../../src/local-package"],
    });
    await writeJson(outputPath, {
      lastChangelogVersion: "1.2.3",
      compaction: { reserveTokens: 8192 },
      packages: ["npm:shared", "npm:existing-only"],
    });

    await execFileAsync(process.execPath, [
      scriptPath,
      sharedPath,
      localPath,
      outputPath,
    ]);

    const result = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(result, {
      lastChangelogVersion: "1.2.3",
      compaction: { reserveTokens: 8192, enabled: true },
      packages: [
        "npm:shared",
        "npm:filtered",
        "../../src/local-package",
        "npm:existing-only",
      ],
      theme: "light",
    });
  });
});

test("works without local or existing settings", async () => {
  await withTempDirectory(async (directory) => {
    const sharedPath = join(directory, "shared.json");
    const localPath = join(directory, "missing-local.json");
    const outputPath = join(directory, "settings.json");

    await writeJson(sharedPath, {
      defaultThinkingLevel: "high",
      packages: ["npm:one"],
    });

    await execFileAsync(process.execPath, [
      scriptPath,
      sharedPath,
      localPath,
      outputPath,
    ]);

    const result = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(result, {
      defaultThinkingLevel: "high",
      packages: ["npm:one"],
    });
  });
});
