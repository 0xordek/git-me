#!/usr/bin/env node

// src/cli.ts
import { pathToFileURL } from "node:url";

// src/lfs-client.ts
var LFS_JSON = "application/vnd.git-lfs+json";
var ERROR_SNIPPET_BYTES = 200;
var nodeImport = (specifier) => import(
  /* @vite-ignore */
  specifier
);
function mergeActionHeaders(base, actionHeaders) {
  return { ...base, ...actionHeaders ?? {} };
}
var LfsClient = class {
  baseUrl;
  baseOrigin;
  headers;
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.headers = options.headers ?? {};
  }
  async batch(operation, objects) {
    const response = await fetch(`${this.baseUrl}/objects/batch`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": LFS_JSON, Accept: LFS_JSON },
      body: JSON.stringify({ operation, transfers: ["basic"], objects })
    });
    await throwIfFailed(response, "LFS batch");
    return await response.json();
  }
  async downloadToFile(href, filePath, headers) {
    const response = await fetch(href, { method: "GET", headers: this.actionHeaders(href, headers) });
    await throwIfFailed(response, "LFS download");
    if (!response.body) throw new Error("LFS download failed: response body missing");
    const [fs, stream, streamPromises] = await Promise.all([
      nodeImport("node:fs"),
      nodeImport("node:stream"),
      nodeImport("node:stream/promises")
    ]);
    await streamPromises.pipeline(stream.Readable.fromWeb(response.body), fs.createWriteStream(filePath));
  }
  async uploadFromFile(href, filePath, headers) {
    const [fs, fsPromises] = await Promise.all([nodeImport("node:fs"), nodeImport("node:fs/promises")]);
    const stat = await fsPromises.stat(filePath);
    const init = {
      method: "PUT",
      headers: { ...this.actionHeaders(href, headers), "Content-Length": String(stat.size) },
      body: fs.createReadStream(filePath),
      duplex: "half"
    };
    const response = await fetch(href, init);
    await throwIfFailed(response, "LFS upload");
  }
  actionHeaders(href, headers) {
    const actionOrigin = new URL(href, this.baseUrl).origin;
    if (actionOrigin !== this.baseOrigin) return headers ?? {};
    return mergeActionHeaders(this.headers, headers);
  }
};
async function throwIfFailed(response, label) {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  const snippet = body.slice(0, ERROR_SNIPPET_BYTES);
  throw new Error(`${label} failed with status ${response.status}: ${snippet}`);
}

// src/pointers.ts
var VERSION_LINE = "version https://git-lfs.github.com/spec/v1";
var OID_LINE = /^oid sha256:([0-9a-fA-F]{64})$/;
var SIZE_LINE = /^size ([0-9]+)$/;
var MAX_POINTER_BYTES = 1024;
var nodeImport2 = (specifier) => import(
  /* @vite-ignore */
  specifier
);
function parsePointer(text, path) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 3 || lines[0] !== VERSION_LINE) return null;
  const oid = OID_LINE.exec(lines[1])?.[1];
  if (!oid) return null;
  const sizeText = SIZE_LINE.exec(lines[2])?.[1];
  if (!sizeText) return null;
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size)) return null;
  return { path, oid: oid.toLowerCase(), size };
}
async function scanPointers(repoPath) {
  const trackedPaths = await listTrackedFiles(repoPath);
  const [fs, path] = await Promise.all([nodeImport2("node:fs/promises"), nodeImport2("node:path")]);
  const pointers = [];
  for (const trackedPath of trackedPaths) {
    const text = await readSmallUtf8File(fs, path.join(repoPath, trackedPath));
    if (text === null) continue;
    const pointer = parsePointer(text, trackedPath);
    if (pointer) pointers.push(pointer);
  }
  return pointers;
}
async function listTrackedFiles(repoPath) {
  const childProcess = await nodeImport2("node:child_process");
  const stdout = await new Promise((resolve, reject) => {
    childProcess.execFile("git", ["-C", repoPath, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (error, output, stderr) => {
      if (error) {
        reject(new Error(`${error.message}
${stderr}`));
        return;
      }
      resolve(output);
    });
  });
  return stdout.split("\0").filter((trackedPath) => trackedPath.length > 0);
}
async function readSmallUtf8File(fs, path) {
  let file = null;
  try {
    file = await fs.open(path, "r");
    const bytes = new Uint8Array(MAX_POINTER_BYTES);
    const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, 0);
    const chunk = bytes.subarray(0, bytesRead);
    if (chunk.includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(chunk);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => void 0);
  }
}

// src/migrate.ts
var nodeImport3 = (specifier) => import(
  /* @vite-ignore */
  specifier
);
async function migrate(options, deps = {}) {
  const scan = deps.scanPointers ?? scanPointers;
  const createClient = deps.createClient ?? ((clientOptions) => new LfsClient(clientOptions));
  const createTempPath = deps.createTempPath ?? defaultCreateTempPath;
  const removeFile = deps.removeFile ?? defaultRemoveFile;
  const getGitConfig = deps.getGitConfig ?? getGitConfigValue;
  const setGitConfig = deps.setGitConfig ?? setGitConfigValue;
  const pointers = await scan(options.repoPath);
  const uniqueObjects = uniqueLfsObjects(pointers);
  const result = {
    scanned: pointers.length,
    unique: uniqueObjects.length,
    migrated: 0,
    skipped: pointers.length - uniqueObjects.length,
    failed: []
  };
  if (options.dryRun) return result;
  const sourceUrl = options.sourceUrl ?? await getGitConfig(options.repoPath, "lfs.url");
  const source = createClient({ baseUrl: sourceUrl.trim(), headers: options.sourceHeaders });
  const target = createClient({ baseUrl: options.targetUrl, headers: { Authorization: `Bearer ${options.targetToken}` } });
  await runPool(uniqueObjects, options.concurrency, async (object) => {
    const tempPath = await createTempPath();
    try {
      const download = await batchAction(source, "download", object, "download");
      if (!download) throw new Error("download action missing");
      await source.downloadToFile(download.href, tempPath, download.header);
      if (await sha256File(tempPath) !== object.oid) throw new Error("hash mismatch");
      const upload = await batchAction(target, "upload", object, "upload");
      if (!upload) {
        result.skipped += 1;
        return;
      }
      await target.uploadFromFile(upload.href, tempPath, upload.header);
      const targetDownload = await batchAction(target, "download", object, "download");
      if (!targetDownload) throw new Error("target download action missing");
      result.migrated += 1;
    } catch (error) {
      result.failed.push({ oid: object.oid, reason: errorMessage(error) });
    } finally {
      await removeFile(tempPath).catch(() => void 0);
    }
  });
  if (options.writeConfig && result.failed.length === 0) {
    await setGitConfig(options.repoPath, "lfs.url", options.targetUrl);
  }
  return result;
}
function uniqueLfsObjects(pointers) {
  const seen = /* @__PURE__ */ new Set();
  const objects = [];
  for (const pointer of pointers) {
    if (seen.has(pointer.oid)) continue;
    seen.add(pointer.oid);
    objects.push({ oid: pointer.oid, size: pointer.size });
  }
  return objects;
}
async function batchAction(client, operation, object, action) {
  const response = await client.batch(operation, [object]);
  const responseObject = response.objects.find((item) => item.oid === object.oid);
  if (!responseObject) throw new Error(`${operation} batch missing object`);
  if (responseObject.error) throw new Error(responseObject.error.message);
  return responseObject.actions?.[action] ?? null;
}
async function runPool(items, concurrency, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}
async function sha256File(path) {
  const [fs, cryptoModule] = await Promise.all([nodeImport3("node:fs"), nodeImport3("node:crypto")]);
  const hash = cryptoModule.createHash("sha256");
  const stream = fs.createReadStream(path);
  return await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
async function defaultCreateTempPath() {
  const [os, path] = await Promise.all([nodeImport3("node:os"), nodeImport3("node:path")]);
  return path.join(os.tmpdir(), `git-me-migrate-${crypto.randomUUID()}`);
}
async function defaultRemoveFile(path) {
  const fs = await nodeImport3("node:fs/promises");
  await fs.rm(path, { force: true });
}
async function getGitConfigValue(repoPath, key) {
  return (await execGit(repoPath, ["config", "--get", key])).trim();
}
async function setGitConfigValue(repoPath, key, value) {
  await execGit(repoPath, ["config", key, value]);
}
async function execGit(repoPath, args) {
  const childProcess = await nodeImport3("node:child_process");
  return await new Promise((resolve, reject) => {
    childProcess.execFile("git", ["-C", repoPath, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}
${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/cli.ts
async function runCli(argv, io = {}) {
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    out(topLevelUsage());
    return 0;
  }
  const [command, ...args] = argv;
  if (command === "migrate") return await runMigrate(args, { ...io, stdout: out, stderr: err });
  err(`unknown command: ${command}

${topLevelUsage()}`);
  return 2;
}
async function runMigrate(args, io) {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(migrateUsage());
    return 0;
  }
  const parsed = parseMigrateArgs(args, io.cwd?.() ?? process.cwd());
  if ("error" in parsed) {
    io.stderr(`${parsed.error}

${migrateUsage()}`);
    return 2;
  }
  try {
    const result = await (io.migrate ?? migrate)(parsed.options);
    io.stdout(formatResult(result));
    return result.failed.length === 0 ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}
`);
    return 1;
  }
}
function parseMigrateArgs(args, defaultRepoPath) {
  const sourceHeaders = {};
  let repoPath = defaultRepoPath;
  let sourceUrl;
  let targetUrl;
  let targetToken;
  let concurrency = 4;
  let dryRun = false;
  let writeConfig = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--write-config") {
      writeConfig = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return { error: `missing value for ${arg}` };
    index += 1;
    if (arg === "--repo") repoPath = value;
    else if (arg === "--source-url") sourceUrl = value;
    else if (arg === "--target") targetUrl = value;
    else if (arg === "--token") targetToken = value;
    else if (arg === "--concurrency") {
      concurrency = Number(value);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) return { error: "invalid --concurrency" };
    } else if (arg === "--source-header") {
      const header = parseHeader(value);
      if (!header) return { error: "invalid --source-header" };
      sourceHeaders[header.name] = header.value;
    } else return { error: `unknown option: ${arg}` };
  }
  if (!targetUrl) return { error: "missing required option: --target" };
  if (!targetToken) return { error: "missing required option: --token" };
  return { options: { repoPath, sourceUrl, sourceHeaders, targetUrl, targetToken, concurrency, dryRun, writeConfig } };
}
function parseHeader(input) {
  const index = input.indexOf(":");
  if (index < 1) return null;
  const name = input.slice(0, index).trim();
  const value = input.slice(index + 1).trim();
  return name && value ? { name, value } : null;
}
function topLevelUsage() {
  return `Usage: git-me <command>

Commands:
  migrate  migrate Git LFS objects to git-me
`;
}
function migrateUsage() {
  return `Usage: git-me migrate --target <url> --token <token> [options]

Options:
  --repo <path>                 repository path (default: current directory)
  --source-url <url>            source LFS URL (default: git config lfs.url)
  --source-header <name: value> source LFS header, repeatable
  --concurrency <number>        concurrent transfers, 1..16 (default: 4)
  --dry-run                     scan without transferring objects
  --write-config                update lfs.url after successful migration
`;
}
function formatResult(result) {
  const lines = [`scanned=${result.scanned} unique=${result.unique} migrated=${result.migrated} skipped=${result.skipped} failed=${result.failed.length}`];
  for (const failure of result.failed) lines.push(`${failure.oid}: ${failure.reason}`);
  return `${lines.join("\n")}
`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  });
}
export {
  runCli
};
