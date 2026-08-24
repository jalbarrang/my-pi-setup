import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "inbound" && mode !== "reload") {
  console.error("Usage: node test/e2e.mjs <inbound|reload>");
  process.exit(2);
}

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cwd = process.env.PI_BRIDGE_TEST_CWD ?? testDirectory;
const reloadExtension = join(testDirectory, "reload-extension.ts");
const timeoutMs = 40_000;

function attachJsonl(stream, onValue) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onValue(JSON.parse(line));
      } catch {
        // Pi RPC stdout should be JSONL; ignore startup noise if any.
      }
    }
  });
}

function makeEventReader(stream) {
  const buffered = [];
  const waiting = [];

  attachJsonl(stream, (event) => {
    const matchIndex = waiting.findIndex(({ predicate }) => predicate(event));
    if (matchIndex >= 0) {
      const [{ resolve, timer }] = waiting.splice(matchIndex, 1);
      clearTimeout(timer);
      resolve(event);
      return;
    }
    buffered.push(event);
  });

  return (predicate, label) => {
    const matchIndex = buffered.findIndex(predicate);
    if (matchIndex >= 0) return Promise.resolve(buffered.splice(matchIndex, 1)[0]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiting.findIndex((entry) => entry.resolve === resolve);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      waiting.push({ predicate, resolve, timer });
    });
  };
}

function writeCommand(process, command) {
  process.stdin.write(`${JSON.stringify(command)}\n`);
}

async function sendFromClaude(target, message) {
  const senderName = `pi-bridge-e2e-sender-${randomUUID().slice(0, 6)}`;
  const systemPrompt = [
    "You are a test sender.",
    "Call SendMessage exactly once using the exact target and message in the JSON command.",
    "Do not call any other tool.",
  ].join(" ");
  const prompt = JSON.stringify({ target, message });
  const args = [
    "-p",
    "--name",
    senderName,
    "--output-format",
    "json",
    "--model",
    "haiku",
    "--tools",
    "SendMessage",
    "--allowedTools",
    "SendMessage",
    "--permission-mode",
    "dontAsk",
    "--system-prompt",
    systemPrompt,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    prompt,
  ];

  const sender = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  sender.stdout.on("data", (chunk) => (stdout += chunk));
  sender.stderr.on("data", (chunk) => (stderr += chunk));

  const code = await new Promise((resolve, reject) => {
    sender.on("error", reject);
    sender.on("close", resolve);
  });

  if (code !== 0) throw new Error(`Claude sender exited ${code}: ${stderr.trim()}`);
  return { senderName, stdout };
}

const pi = spawn(
  "pi",
  ["--mode", "rpc", "--no-session", "--no-builtin-tools", "-e", reloadExtension],
  { cwd, stdio: ["pipe", "pipe", "pipe"] },
);
const nextEvent = makeEventReader(pi.stdout);
let piStderr = "";
let lastSenderOutput = "";
pi.stderr.on("data", (chunk) => (piStderr += chunk));

try {
  writeCommand(pi, {
    id: "start",
    type: "prompt",
    message: "/claude-bridge start",
  });

  const notification = await nextEvent(
    (event) =>
      event.type === "extension_ui_request" &&
      event.method === "notify" &&
      typeof event.message === "string" &&
      event.message.includes("This session is "),
    "bridge start notification",
  );

  const nameMatch = notification.message.match(/^This session is ([^ ]+) /m);
  if (!nameMatch) throw new Error(`Could not parse bridge name from: ${notification.message}`);
  const bridgeName = nameMatch[1];

  await nextEvent(
    (event) => event.type === "response" && event.id === "start" && event.success === true,
    "bridge start response",
  );

  if (mode === "reload") {
    writeCommand(pi, {
      id: "reload",
      type: "prompt",
      message: "/test-claude-bridge-reload",
    });
    await nextEvent(
      (event) => event.type === "response" && event.id === "reload" && event.success === true,
      "reload response",
    );
  }

  const marker = `pi-bridge-e2e-${mode}-${randomUUID()}`;
  const sender = await sendFromClaude(bridgeName, marker);
  lastSenderOutput = sender.stdout;

  const receivedEvent = await nextEvent(
    (event) => {
      const serialized = JSON.stringify(event);
      return serialized.includes("claude-peer-message") && serialized.includes(marker);
    },
    "peer message in Pi",
  );

  const received = JSON.stringify(receivedEvent);
  if (!received.includes(`\"replyTo\":\"${sender.senderName}\"`)) {
    throw new Error(`Pi received the message without a stable sender-name reply target: ${received}`);
  }

  console.log(`PASS ${mode}: ${bridgeName} received ${marker}`);
  writeCommand(pi, { type: "abort" });
} catch (error) {
  console.error(`FAIL ${mode}: ${error instanceof Error ? error.message : String(error)}`);
  if (lastSenderOutput.trim()) console.error(`Sender output: ${lastSenderOutput.trim()}`);
  if (piStderr.trim()) console.error(`Pi stderr: ${piStderr.trim()}`);
  process.exitCode = 1;
} finally {
  pi.stdin.end();
  pi.kill("SIGTERM");
}
