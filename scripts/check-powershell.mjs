import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "bootstrap.ps1");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-bootstrap-pwsh-"));

function runBootstrap(piDirectory) {
  return spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-SkipDeps"],
    {
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: piDirectory },
    },
  );
}

function assertSuccessful(result) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `PowerShell bootstrap failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

try {
  const piDirectory = join(temporaryDirectory, "agent");
  const firstRun = runBootstrap(piDirectory);

  if (firstRun.error?.code === "ENOENT") {
    console.log("pwsh is not installed; PowerShell bootstrap check skipped");
    process.exit(0);
  }

  assertSuccessful(firstRun);

  const secondRun = runBootstrap(piDirectory);
  assertSuccessful(secondRun);
  if (secondRun.stdout.includes("Backed up")) {
    throw new Error("PowerShell bootstrap is not idempotent on a repeated run");
  }

  const settings = JSON.parse(
    await readFile(join(piDirectory, "settings.json"), "utf8"),
  );
  if (!Array.isArray(settings.packages) || settings.packages.length === 0) {
    throw new Error("PowerShell bootstrap did not generate package settings");
  }

  console.log("PowerShell bootstrap smoke test passed");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
