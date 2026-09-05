import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentOs } from "@rivet-dev/agentos-core";

const RESULT_MARKER = "OPENCLAW_AGENTOS_AUDIT=";
const REGISTRY_MARKER = "OPENCLAW_AGENTOS_BUILTINS=";

function parseArguments(argv) {
  const result = { strict: false, report: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") {
      result.strict = true;
      continue;
    }
    if (argument === "--report") {
      const report = argv[index + 1];
      if (!report) throw new Error("--report requires a path");
      result.report = resolve(report);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

function splitImportClause(clause) {
  const trimmed = clause.trim();
  const namedStart = trimmed.indexOf("{");
  const namedEnd = trimmed.lastIndexOf("}");
  const named =
    namedStart === -1 || namedEnd === -1
      ? []
      : trimmed
          .slice(namedStart + 1, namedEnd)
          .split(",")
          .map((entry) => entry.trim().split(/\s+as\s+/u)[0])
          .filter(Boolean);
  return {
    default: !trimmed.startsWith("{") && !trimmed.startsWith("*"),
    namespace: trimmed.startsWith("*") || /,\s*\*/u.test(trimmed),
    named,
  };
}

function normalizeBuiltin(specifier) {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (!specifier.startsWith("node:") && !builtinModules.includes(bare)) return undefined;
  return `node:${bare}`;
}

function inventoryBuiltinImports(source) {
  const firstStatement = source.indexOf(";var ");
  if (firstStatement === -1) {
    throw new Error("OpenClaw worker does not have the expected bundled import preamble");
  }
  const preamble = source.slice(0, firstStatement + 1);
  const imports = new Map();
  const pattern = /import\s*(.+?)\s*from\s*["']([^"']+)["'];/gu;
  for (const match of preamble.matchAll(pattern)) {
    const specifier = normalizeBuiltin(match[2]);
    if (!specifier) continue;
    const clause = splitImportClause(match[1]);
    const existing = imports.get(specifier) ?? {
      specifier,
      default: false,
      namespace: false,
      named: new Set(),
    };
    existing.default ||= clause.default;
    existing.namespace ||= clause.namespace;
    for (const name of clause.named) existing.named.add(name);
    imports.set(specifier, existing);
  }
  return [...imports.values()]
    .map((entry) => ({ ...entry, named: [...entry.named].sort() }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier));
}

function guestProbeSource(specifiers) {
  return `
const specifiers = ${JSON.stringify(specifiers)};
const results = {};
for (const specifier of specifiers) {
  try {
    const module = await import(specifier);
    results[specifier] = {
      resolved: true,
      exports: Object.keys(module).sort(),
    };
  } catch (error) {
    results[specifier] = {
      resolved: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(results));
`;
}

function vmOptions(allowedNodeBuiltins) {
  return {
    ...(allowedNodeBuiltins ? { allowedNodeBuiltins } : {}),
    permissions: {
      fs: "allow",
      childProcess: "allow",
      process: "allow",
      env: "allow",
      network: "deny",
    },
    limits: {
      resources: {
        maxProcesses: 32,
        maxOpenFds: 256,
        maxSockets: 64,
        maxFilesystemBytes: 256 * 1024 * 1024,
      },
      jsRuntime: {
        v8HeapLimitMb: 256,
        cpuTimeLimitMs: 120_000,
        wallClockLimitMs: 180_000,
        importCacheMaterializeTimeoutMs: 120_000,
        syncRpcWaitTimeoutMs: 120_000,
      },
    },
  };
}

async function discoverAgentOsBuiltins() {
  const vm = await AgentOs.create(vmOptions());
  try {
    const execution = await vm.process.execFile(
      "node",
      [
        "-e",
        `const { builtinModules } = require("node:module"); console.log(${JSON.stringify(
          REGISTRY_MARKER,
        )} + JSON.stringify(builtinModules));`,
      ],
      { timeoutMs: 120_000, output: { capture: "all" } },
    );
    if (execution.outcome !== "succeeded" || execution.exitCode !== 0) {
      const detail = execution.stderr?.trim() || execution.stdout?.trim() || execution.outcome;
      throw new Error(`AgentOS builtin discovery failed: ${detail}`);
    }
    const resultLine = execution.stdout
      ?.split("\n")
      .find((line) => line.startsWith(REGISTRY_MARKER));
    if (!resultLine) throw new Error("AgentOS builtin discovery returned no registry");
    return JSON.parse(resultLine.slice(REGISTRY_MARKER.length));
  } finally {
    await vm.dispose();
  }
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function makeReport(metadata, results) {
  const blockers = results.filter((result) => result.status !== "compatible");
  const lines = [
    "# OpenClaw worker compatibility audit",
    "",
    `- OpenClaw: \`${metadata.openClawVersion}\``,
    `- AgentOS: \`${metadata.agentOsVersion}\``,
    `- Worker SHA-256: \`${metadata.workerSha256}\``,
    `- Worker bytes: \`${metadata.workerBytes}\``,
    `- Builtin modules imported: \`${results.length}\``,
    `- Blocking modules: \`${blockers.length}\``,
    "",
    "| Builtin | Required named exports | Result | Missing/error |",
    "| --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const required = [
      ...(result.requirements.default ? ["default"] : []),
      ...result.requirements.named,
      ...(result.requirements.namespace ? ["namespace"] : []),
    ];
    const detail = result.error ?? (result.missing.join(", ") || "—");
    lines.push(
      `| \`${result.specifier}\` | ${escapeCell(required.join(", ") || "—")} | ${result.status} | ${escapeCell(detail)} |`,
    );
  }
  lines.push(
    "",
    "`compatible` means the module resolved and exposed every statically imported",
    "named/default export. It does not prove behavioral equivalence with Node.js.",
    "Namespace imports are recorded but cannot be exhaustively validated statically.",
    "",
  );
  return lines.join("\n");
}

const arguments_ = parseArguments(process.argv.slice(2));
const repository = resolve(process.env.OPENCLAW_REPO ?? "../openclaw-2.0");
const workerPath = resolve(repository, "dist/worker/worker.mjs");
const packagePath = resolve(repository, "package.json");
const worker = await readFile(workerPath, "utf8");
const openClawPackage = JSON.parse(await readFile(packagePath, "utf8"));
const agentOsPackage = JSON.parse(
  await readFile(resolve("node_modules/@rivet-dev/agentos-core/package.json"), "utf8"),
);
const inventory = inventoryBuiltinImports(worker);
const registeredBuiltins = new Set(await discoverAgentOsBuiltins());
const recognizedInventory = inventory.filter(({ specifier }) =>
  registeredBuiltins.has(specifier.slice(5)),
);
const unknownInventory = inventory.filter(
  ({ specifier }) => !registeredBuiltins.has(specifier.slice(5)),
);
const allowedNodeBuiltins = recognizedInventory.map(({ specifier }) => specifier.slice(5));
const vm = await AgentOs.create(vmOptions(allowedNodeBuiltins));

let runtimeResults;
try {
  const guestPath = "/home/agentos/openclaw-agentos-builtin-audit.mjs";
  await vm.filesystem.writeFile(
    guestPath,
    guestProbeSource(recognizedInventory.map(({ specifier }) => specifier)),
  );
  const execution = await vm.process.execFile("node", [guestPath], {
    timeoutMs: 180_000,
    output: { capture: "all" },
  });
  if (execution.outcome !== "succeeded" || execution.exitCode !== 0) {
    const detail = execution.stderr?.trim() || execution.stdout?.trim() || execution.outcome;
    throw new Error(`AgentOS builtin audit failed: ${detail}`);
  }
  const resultLine = execution.stdout
    ?.split("\n")
    .find((line) => line.startsWith(RESULT_MARKER));
  if (!resultLine) throw new Error("AgentOS builtin audit returned no structured result");
  runtimeResults = JSON.parse(resultLine.slice(RESULT_MARKER.length));
  for (const { specifier } of unknownInventory) {
    runtimeResults[specifier] = {
      resolved: false,
      error: "not present in the AgentOS builtin registry",
    };
  }
} finally {
  await vm.dispose();
}

const results = inventory.map((requirements) => {
  const runtime = runtimeResults[requirements.specifier];
  if (!runtime?.resolved) {
    return {
      specifier: requirements.specifier,
      requirements,
      status: "unresolved",
      missing: [],
      error: runtime?.error ?? "no probe result",
    };
  }
  const available = new Set(runtime.exports);
  const missing = [
    ...(requirements.default && !available.has("default") ? ["default"] : []),
    ...requirements.named.filter((name) => !available.has(name)),
  ];
  return {
    specifier: requirements.specifier,
    requirements,
    status: missing.length === 0 ? "compatible" : "missing-export",
    missing,
    exports: runtime.exports,
  };
});

const metadata = {
  openClawVersion: openClawPackage.version,
  agentOsVersion: agentOsPackage.version,
  workerBytes: Buffer.byteLength(worker),
  workerSha256: createHash("sha256").update(worker).digest("hex"),
};
const report = makeReport(metadata, results);
if (arguments_.report) await writeFile(arguments_.report, report);
console.log(report);

const blockers = results.filter((result) => result.status !== "compatible");
if (arguments_.strict && blockers.length > 0) process.exitCode = 1;
