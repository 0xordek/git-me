#!/usr/bin/env node

// src/cli.ts
import { realpathSync } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/credentials.ts
import { execFile } from "node:child_process";
import { platform } from "node:os";
var SERVICE = "git-me";
function createCredentialStore() {
  return new SystemCredentialStore();
}
var SystemCredentialStore = class {
  async get(key) {
    const os = platform();
    if (os === "darwin") return await macGet(key);
    if (os === "linux") return await linuxGet(key);
    if (os === "win32") return await windowsGet(key);
    throw new Error(`credential store unsupported on ${os}`);
  }
  async set(key, value) {
    if (!value) throw new Error("credential cannot be empty");
    const os = platform();
    if (os === "darwin") return await macSet(key, value);
    if (os === "linux") return await linuxSet(key, value);
    if (os === "win32") return await windowsSet(key, value);
    throw new Error(`credential store unsupported on ${os}`);
  }
  async delete(key) {
    const os = platform();
    if (os === "darwin") return await macDelete(key);
    if (os === "linux") return await linuxDelete(key);
    if (os === "win32") return await windowsDelete(key);
    throw new Error(`credential store unsupported on ${os}`);
  }
};
async function macGet(key) {
  const result = await run("security", ["find-generic-password", "-a", SERVICE, "-s", key, "-w"], void 0, true);
  return result?.trim() || null;
}
async function macSet(key, value) {
  await run("security", ["add-generic-password", "-U", "-a", SERVICE, "-s", key, "-w"], value);
}
async function macDelete(key) {
  await run("security", ["delete-generic-password", "-a", SERVICE, "-s", key], void 0, true);
}
async function linuxGet(key) {
  const result = await run("secret-tool", ["lookup", "service", SERVICE, "profile", key], void 0, true);
  return result?.trim() || null;
}
async function linuxSet(key, value) {
  await run("secret-tool", ["store", "--label=git-me credential", "service", SERVICE, "profile", key], value);
}
async function linuxDelete(key) {
  await run("secret-tool", ["clear", "service", SERVICE, "profile", key], void 0, true);
}
async function windowsGet(key) {
  const script = `${windowsCredentialApi()}
$ptr = [IntPtr]::Zero
if ([WinCred]::CredRead($args[0], 1, 0, [ref]$ptr)) {
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][WinCred+CREDENTIAL])
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
  } finally { [WinCred]::CredFree($ptr) }
}`;
  const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, key], void 0, true);
  return result?.trim() || null;
}
async function windowsSet(key, value) {
  const script = `${windowsCredentialApi()}
$value = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($value)
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
  $credential = New-Object WinCred+CREDENTIAL
  $credential.Type = 1
  $credential.TargetName = $args[0]
  $credential.UserName = 'git-me'
  $credential.CredentialBlobSize = $bytes.Length
  $credential.CredentialBlob = $ptr
  $credential.Persist = 2
  if (-not [WinCred]::CredWrite([ref]$credential, 0)) { throw 'CredWrite failed' }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr) }`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, key], value);
}
async function windowsDelete(key) {
  const script = `${windowsCredentialApi()}
[WinCred]::CredDelete($args[0], 1, 0) | Out-Null`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, key], void 0, true);
}
function windowsCredentialApi() {
  return `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint = "CredFree")]
  public static extern void CredFree(IntPtr credential);
}
'@`;
}
function run(command, args, input, ignoreFailure = false) {
  return new Promise((resolve2, reject) => {
    const child = execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        if (ignoreFailure) return resolve2(null);
        reject(new Error(`credential store unavailable: ${stderr.trim() || error.message}`));
        return;
      }
      resolve2(stdout);
    });
    if (input !== void 0) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}

// src/deploy.ts
import { randomBytes } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join as join2, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

// src/profile.ts
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform as platform2 } from "node:os";
import { dirname, join } from "node:path";
function createProfileStore(env = process.env) {
  return new FileProfileStore(profileFilePath(env));
}
var FileProfileStore = class {
  constructor(filePath) {
    this.filePath = filePath;
  }
  filePath;
  async get(name) {
    const file = await readProfileFile(this.filePath);
    const profile = file.profiles[name];
    return profile && profile.name === name ? profile : null;
  }
  async save(profile) {
    const file = await readProfileFile(this.filePath);
    file.profiles[profile.name] = profile;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 448 });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}
`, { mode: 384 });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 384).catch(() => void 0);
  }
};
async function readProfileFile(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object") throw new Error(`invalid profile file: ${filePath}`);
    return {
      version: 1,
      profiles: parsed.profiles
    };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, profiles: {} };
    if (error instanceof SyntaxError) throw new Error(`invalid profile file: ${filePath}`);
    throw error;
  }
}
function profileFilePath(env) {
  if (env.GITME_CONFIG_DIR) return join(env.GITME_CONFIG_DIR, "profiles.json");
  if (platform2() === "win32" && env.APPDATA) return join(env.APPDATA, "git-me", "profiles.json");
  if (platform2() === "darwin") return join(homedir(), "Library", "Application Support", "git-me", "profiles.json");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git-me", "profiles.json");
}

// src/deploy.ts
var COMPATIBILITY_DATE = "2026-07-12";
var require2 = createRequire(import.meta.url);
async function deployWorker(options, deps = {}) {
  const runCommand = deps.runCommand ?? runWrangler;
  const profileStore = deps.profileStore ?? createProfileStore();
  const credentialStore = deps.credentialStore ?? createCredentialStore();
  const createTempDirectory = deps.createTempDirectory ?? (() => mkdtemp(join2(tmpdir(), "git-me-deploy-")));
  const generateSecret = deps.generateSecret ?? (() => randomBytes(32).toString("base64url"));
  const fetchImpl = deps.fetch ?? fetch;
  const workerName = options.workerName || defaultWorkerName();
  const workerNameGenerated = !options.workerName;
  const bucketName = `${workerName}-objects`;
  const kvName = `${workerName}-metadata`;
  const adminSecret = options.adminSecret ?? generateSecret();
  if (await profileStore.get(options.profile)) throw new Error(`profile already exists: ${options.profile}`);
  let storedCredential = false;
  if (!options.adminSecret) {
    try {
      await credentialStore.set(credentialKey(options.profile), adminSecret);
      storedCredential = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; re-run with --token-stdin if the OS credential store is unavailable`);
    }
  }
  const tempDirectory = await createTempDirectory();
  const configPath = join2(tempDirectory, "wrangler.toml");
  const workerBundle = deps.workerBundle ?? defaultWorkerBundle();
  let bucketCreated = false;
  let kvCreated = false;
  let workerDeployed = false;
  let kvNamespaceId;
  try {
    await writeFile2(configPath, initialConfig(workerName, workerBundle));
    await runCommand(["login"], { interactive: true });
    const whoami = await runCommand(["whoami"]);
    const accountId = options.accountId ?? accountIdFromOutput(`${whoami.stdout}
${whoami.stderr}`);
    if (!accountId) throw new Error("Cloudflare did not report an account ID");
    await writeFile2(configPath, initialConfig(workerName, workerBundle, accountId));
    await runCommand(["r2", "bucket", "create", bucketName, "--config", configPath]);
    bucketCreated = true;
    await appendFile(configPath, r2Binding(bucketName));
    const kvOutput = await runCommand(["kv", "namespace", "create", kvName, "--config", configPath]);
    kvCreated = true;
    kvNamespaceId = kvNamespaceIdFromOutput(`${kvOutput.stdout}
${kvOutput.stderr}`);
    if (!kvNamespaceId) throw new Error("Cloudflare did not report a KV namespace ID");
    await appendFile(configPath, kvBinding(kvNamespaceId));
    const deployOutput = await runCommand(["deploy", "--config", configPath, "--no-bundle"]);
    workerDeployed = true;
    const endpoint = endpointFromOutput(`${deployOutput.stdout}
${deployOutput.stderr}`);
    if (!endpoint) throw new Error("Cloudflare did not report a Workers URL after deploy");
    await runCommand(["secret", "put", "GITME_AUTH_TOKEN", "--config", configPath], { input: adminSecret });
    await waitForHealth(endpoint, fetchImpl);
    let warning;
    if (options.adminSecret) {
      try {
        await credentialStore.set(credentialKey(options.profile), adminSecret);
      } catch {
        warning = "Admin credential was not saved to the OS credential store; use --token-stdin for user commands.";
      }
    }
    const result = {
      profile: options.profile,
      endpoint,
      workerName,
      accountId,
      bucketName,
      kvNamespaceId,
      warning
    };
    const profile = {
      name: options.profile,
      endpoint,
      workerName,
      accountId: result.accountId,
      bucketName,
      kvNamespaceId,
      createdAt: (deps.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()))()
    };
    await profileStore.save(profile);
    return result;
  } catch (error) {
    if (storedCredential) await credentialStore.delete(credentialKey(options.profile)).catch(() => void 0);
    const cleanup = [];
    if (workerDeployed && workerNameGenerated) await runCommand(["delete", workerName, "--config", configPath, "--force"]).catch(() => cleanup.push(`Worker ${workerName}`));
    else if (workerDeployed) cleanup.push(`Worker ${workerName}`);
    if (kvCreated && kvNamespaceId) await runCommand(["kv", "namespace", "delete", kvNamespaceId, "--config", configPath]).catch(() => cleanup.push(`KV namespace ${kvName}`));
    else if (kvCreated) cleanup.push(`KV namespace ${kvName}`);
    if (bucketCreated) await runCommand(["r2", "bucket", "delete", bucketName, "--config", configPath]).catch(() => cleanup.push(`R2 bucket ${bucketName}`));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(cleanup.length > 0 ? `${message}. Resources to verify: ${cleanup.join(", ")}` : message);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => void 0);
  }
}
function credentialKey(profile) {
  return `git-me:${profile}:admin`;
}
function defaultWorkerName() {
  return `git-me-${randomBytes(4).toString("hex")}`;
}
function defaultWorkerBundle() {
  return resolve(dirname2(fileURLToPath(import.meta.url)), "worker.js");
}
function initialConfig(workerName, workerBundle, accountId) {
  return [
    `name = ${tomlString(workerName)}`,
    `main = ${tomlString(workerBundle)}`,
    ...accountId ? [`account_id = ${tomlString(accountId)}`] : [],
    `compatibility_date = ${tomlString(COMPATIBILITY_DATE)}`,
    "workers_dev = true",
    "",
    "[[durable_objects.bindings]]",
    'name = "GITME_AUTH"',
    'class_name = "AuthUser"',
    "",
    "[[migrations]]",
    'tag = "v1"',
    'new_sqlite_classes = ["AuthUser"]',
    "",
    "[observability]",
    "enabled = true",
    "",
    "[observability.logs]",
    "enabled = true",
    "head_sampling_rate = 1",
    "",
    "[observability.traces]",
    "enabled = true",
    "head_sampling_rate = 0.01",
    ""
  ].join("\n");
}
function tomlString(value) {
  return `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
}
function r2Binding(bucketName) {
  return `
[[r2_buckets]]
binding = "GITME_R2"
bucket_name = ${tomlString(bucketName)}
`;
}
function kvBinding(namespaceId) {
  return `
[[kv_namespaces]]
binding = "GITME_KV"
id = ${tomlString(namespaceId)}
`;
}
function kvNamespaceIdFromOutput(output) {
  return output.match(/\bid\s*=\s*"([0-9a-f]{32})"/i)?.[1];
}
function endpointFromOutput(output) {
  const field = output.match(/"(?:url|workers_dev_url)"\s*:\s*"(https:\/\/[^"\\]+)"/i)?.[1];
  const endpoint = field ?? output.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev(?:\/[^\s]*)?/i)?.[0];
  return endpoint?.replace(/[),.]+$/, "");
}
function accountIdFromOutput(output) {
  return output.match(/\b[0-9a-f]{32}\b/i)?.[0];
}
async function waitForHealth(endpoint, fetchImpl) {
  let lastError = "health check failed";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetchImpl(new URL("/health", endpoint));
      if (response.ok) {
        const body = await response.json();
        if (body.ok === true) return;
      }
      lastError = `health check returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1e3));
  }
  throw new Error(lastError);
}
async function runWrangler(args, options) {
  const executable = process.env.GITME_WRANGLER_BIN || require2.resolve("wrangler");
  return await spawnCommand(process.execPath, [executable, ...args], options);
}
async function spawnCommand(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: options.interactive ? "inherit" : "pipe" });
    let stdout = "";
    let stderr = "";
    if (!options.interactive) {
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }
    if (options.input !== void 0) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(stderr.trim() || `Cloudflare command failed with exit code ${code ?? "unknown"}`));
    });
  });
}

// src/migrate.ts
import { execFile as execFile3 } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream as createReadStream2 } from "node:fs";
import { mkdtemp as mkdtemp2, rm as rm2 } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { dirname as dirname3, join as join4 } from "node:path";

// src/lfs-client.ts
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// src/url.ts
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
function assertSafeUrl(value, secretBearing) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.username || url.password) throw new Error("URL must not contain embedded credentials");
  if (secretBearing && url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error("secret-bearing URLs must use HTTPS (HTTP is allowed only for loopback)");
  }
}

// src/lfs-client.ts
var LFS_JSON = "application/vnd.git-lfs+json";
var ERROR_SNIPPET_BYTES = 200;
function mergeActionHeaders(base, actionHeaders) {
  return { ...base, ...actionHeaders ?? {} };
}
var LfsClient = class {
  baseUrl;
  baseOrigin;
  headers;
  constructor(options) {
    assertSafeUrl(options.baseUrl, Object.keys(options.headers ?? {}).length > 0);
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
    await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath, { flags: "wx", mode: 384 }));
  }
  async uploadFromFile(href, filePath, headers) {
    const size = (await stat(filePath)).size;
    const init = {
      method: "PUT",
      headers: { ...this.actionHeaders(href, headers), "Content-Length": String(size) },
      body: createReadStream(filePath),
      duplex: "half"
    };
    const response = await fetch(href, init);
    await throwIfFailed(response, "LFS upload");
  }
  actionHeaders(href, headers) {
    const actionOrigin = new URL(href, this.baseUrl).origin;
    const result = actionOrigin === this.baseOrigin ? mergeActionHeaders(this.headers, headers) : headers ?? {};
    assertSafeUrl(new URL(href, this.baseUrl).href, true);
    return result;
  }
};
async function throwIfFailed(response, label) {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`${label} failed with status ${response.status}: ${body.slice(0, ERROR_SNIPPET_BYTES)}`);
}

// src/pointers.ts
import { execFile as execFile2 } from "node:child_process";
import { open } from "node:fs/promises";
import { join as join3 } from "node:path";
var VERSION_LINE = "version https://git-lfs.github.com/spec/v1";
var OID_LINE = /^oid sha256:([0-9a-fA-F]{64})$/;
var SIZE_LINE = /^size ([0-9]+)$/;
var MAX_POINTER_BYTES = 1024;
function parsePointer(text, path) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 3 || lines[0] !== VERSION_LINE) return null;
  const oid = OID_LINE.exec(lines[1] ?? "")?.[1];
  const sizeText = SIZE_LINE.exec(lines[2] ?? "")?.[1];
  if (!oid || !sizeText) return null;
  const size = Number(sizeText);
  return Number.isSafeInteger(size) ? { path, oid: oid.toLowerCase(), size } : null;
}
async function scanPointers(repoPath) {
  const trackedPaths = await listTrackedFiles(repoPath);
  const pointers = [];
  for (const trackedPath of trackedPaths) {
    const text = await readSmallUtf8File(join3(repoPath, trackedPath));
    if (text === null) continue;
    const pointer = parsePointer(text, trackedPath);
    if (pointer) pointers.push(pointer);
  }
  return pointers;
}
async function listTrackedFiles(repoPath) {
  const stdout = await new Promise((resolve2, reject) => {
    execFile2("git", ["-C", repoPath, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (error, output, stderr) => {
      if (error) reject(new Error(`${error.message}
${stderr}`));
      else resolve2(output);
    });
  });
  return stdout.split("\0").filter(Boolean);
}
async function readSmallUtf8File(path) {
  let file = null;
  try {
    file = await open(path, "r");
    const bytes = new Uint8Array(MAX_POINTER_BYTES);
    const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, 0);
    const chunk = bytes.subarray(0, bytesRead);
    return chunk.includes(0) ? null : new TextDecoder("utf-8", { fatal: true }).decode(chunk);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => void 0);
  }
}

// src/migrate.ts
async function migrate(options, deps = {}) {
  const scan = deps.scanPointers ?? scanPointers;
  const createClient = deps.createClient ?? ((clientOptions) => new LfsClient(clientOptions));
  const createTempPath = deps.createTempPath ?? defaultCreateTempPath;
  const removeFile = deps.removeFile ?? defaultRemoveFile;
  const getGitConfig = deps.getGitConfig ?? getGitConfigValue;
  const setGitConfig = deps.setGitConfig ?? setGitConfigValue;
  assertSafeUrl(options.targetUrl, true);
  const pointers = await scan(options.repoPath);
  const { objects, conflicts } = classifyPointers(pointers);
  const unique = objects.length + conflicts.length;
  const result = {
    scanned: pointers.length,
    unique,
    migrated: 0,
    skipped: pointers.length - unique,
    failed: conflicts
  };
  if (options.dryRun) return result;
  const sourceUrl = (options.sourceUrl ?? await getGitConfig(options.repoPath, "lfs.url")).trim();
  assertSafeUrl(sourceUrl, Object.keys(options.sourceHeaders).length > 0);
  const source = createClient({ baseUrl: sourceUrl, headers: options.sourceHeaders });
  const target = createClient({ baseUrl: options.targetUrl, headers: { Authorization: `Bearer ${options.targetToken}` } });
  await runPool(objects, options.concurrency, async (object) => {
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
      if (!await batchAction(target, "download", object, "download")) throw new Error("target download action missing");
      result.migrated += 1;
    } catch (error) {
      result.failed.push({ oid: object.oid, reason: errorMessage(error) });
    } finally {
      await removeFile(tempPath).catch(() => void 0);
    }
  });
  if (options.writeConfig && result.failed.length === 0) await setGitConfig(options.repoPath, "lfs.url", options.targetUrl);
  return result;
}
function classifyPointers(pointers) {
  const sizes = /* @__PURE__ */ new Map();
  const conflicts = /* @__PURE__ */ new Map();
  for (const pointer of pointers) {
    const size = sizes.get(pointer.oid);
    if (size === void 0) sizes.set(pointer.oid, pointer.size);
    else if (size !== pointer.size) conflicts.set(pointer.oid, /* @__PURE__ */ new Set([size, pointer.size, ...conflicts.get(pointer.oid) ?? []]));
  }
  return {
    objects: [...sizes].filter(([oid]) => !conflicts.has(oid)).map(([oid, size]) => ({ oid, size })),
    conflicts: [...conflicts].map(([oid, values]) => ({ oid, reason: `conflicting pointer sizes: ${[...values].sort((a, b) => a - b).join(", ")}` }))
  };
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
      if (item !== void 0) await worker(item);
    }
  });
  await Promise.all(workers);
}
async function sha256File(path) {
  const hash = createHash("sha256");
  const stream = createReadStream2(path);
  return await new Promise((resolve2, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve2(hash.digest("hex")));
  });
}
async function defaultCreateTempPath() {
  return join4(await mkdtemp2(join4(tmpdir2(), "git-me-migrate-")), "object");
}
async function defaultRemoveFile(path) {
  await rm2(dirname3(path), { recursive: true, force: true });
}
async function getGitConfigValue(repoPath, key) {
  return (await execGit(repoPath, ["config", "--get", key])).trim();
}
async function setGitConfigValue(repoPath, key, value) {
  await execGit(repoPath, ["config", key, value]);
}
async function execGit(repoPath, args) {
  return await new Promise((resolve2, reject) => {
    execFile3("git", ["-C", repoPath, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}
${stderr}`));
      else resolve2(stdout);
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
  if (command === "user") return await runUser(args, { ...io, stdout: out, stderr: err });
  if (command === "worker") return await runWorker(args, { ...io, stdout: out, stderr: err });
  err(`unknown command: ${command}

${topLevelUsage()}`);
  return 2;
}
async function runUser(args, io) {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(userUsage());
    return 0;
  }
  let parsed;
  try {
    parsed = await parseUserArgs(args, io);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}

${userUsage()}`);
    return 2;
  }
  if ("error" in parsed) {
    io.stderr(`${parsed.error}

${userUsage()}`);
    return 2;
  }
  if (parsed.options.action === "delete" && !parsed.options.yes && (io.confirm || !io.userRequest)) {
    const confirmed = await (io.confirm ?? confirmPrompt)(`Delete user "${parsed.options.username}"? [y/N] `);
    if (!confirmed) {
      io.stdout("Cancelled.\n");
      return 0;
    }
  }
  try {
    const result = await (io.userRequest ?? requestUser)(parsed.options);
    io.stdout(formatUserResult(result, parsed.options.json === true));
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}
`);
    return 1;
  }
}
async function runWorker(args, io) {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(workerUsage());
    return 0;
  }
  const parsed = await parseWorkerArgs(args, io);
  if ("error" in parsed) {
    io.stderr(`${parsed.error}

${workerUsage()}`);
    return 2;
  }
  try {
    const result = await (io.workerDeploy ?? deployWorker)(parsed.options);
    io.stdout(`Deployed: ${result.endpoint}
Profile: ${result.profile}
LFS URL: ${result.endpoint}
${result.warning ? `Warning: ${result.warning}
` : ""}`);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}
`);
    return 1;
  }
}
async function runMigrate(args, io) {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(migrateUsage());
    return 0;
  }
  const parsed = await parseMigrateArgs(args, io.cwd?.() ?? process.cwd(), io);
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
async function parseUserArgs(args, io) {
  const action = args[0];
  if (action !== "add" && action !== "delete" && action !== "list") return { error: "missing user action: add, list, or delete" };
  let targetUrl = "";
  let token;
  let username = "";
  let password;
  let access = action === "add" ? "read" : "";
  let profileName = "default";
  let yes = false;
  let jsonOutput = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      if (username) return { error: "duplicate username" };
      username = arg;
      continue;
    }
    if (arg === "--token-stdin") {
      if (token) return { error: "duplicate token source" };
      token = { stdin: true };
      continue;
    }
    if (arg === "--password-stdin") {
      if (password) return { error: "duplicate password source" };
      password = { stdin: true };
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return { error: `missing value for ${arg}` };
    index += 1;
    if (arg === "--target") targetUrl = value;
    else if (arg === "--token-env") {
      if (token) return { error: "duplicate token source" };
      const source = envSecret(value);
      if (!source) return { error: `invalid environment variable name: ${value}` };
      token = source;
    } else if (arg === "--username") username = value;
    else if (arg === "--password-env") {
      if (password) return { error: "duplicate password source" };
      const source = envSecret(value);
      if (!source) return { error: `invalid environment variable name: ${value}` };
      password = source;
    } else if (arg === "--access") {
      access = value;
    } else if (arg === "--profile") profileName = value;
    else return { error: `unknown option: ${arg}` };
  }
  const explicitTarget = Boolean(targetUrl);
  const profileStore = io.profileStore ?? createProfileStore(io.env ?? process.env);
  const profile = explicitTarget ? null : await profileStore.get(profileName);
  if (!targetUrl) targetUrl = profile?.endpoint || "";
  if (!token && profile) {
    const credentialStore = io.credentialStore ?? createCredentialStore();
    const storedToken = await credentialStore.get(credentialKey(profileName));
    if (storedToken) token = { value: storedToken };
  }
  if (!targetUrl) return { error: "missing profile; deploy a worker first or provide --target" };
  try {
    assertSafeUrl(targetUrl, true);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!token) return { error: "missing admin credential; provide --token-env or --token-stdin" };
  if (action !== "list" && !username) return { error: "missing username" };
  if (action === "add" && access !== "read" && access !== "write") return { error: "invalid --access read|write" };
  if (isStdinSecret(token) && password && isStdinSecret(password)) return { error: "only one secret may use standard input" };
  try {
    let resolvedPassword;
    if (action === "add") {
      resolvedPassword = password ? await readSecret(password, io) : await (io.readPassword ?? readPassword)("Password: ");
      if (!resolvedPassword) return { error: "password is empty" };
    }
    return {
      options: {
        action,
        targetUrl,
        token: await readSecret(token, io),
        username: username || void 0,
        password: resolvedPassword,
        access: access || void 0,
        ...yes ? { yes: true } : {},
        ...jsonOutput ? { json: true } : {}
      }
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
async function requestUser(options) {
  assertSafeUrl(options.targetUrl, true);
  const path = options.action === "list" ? "/admin/users" : `/admin/users/${encodeURIComponent(options.username || "")}`;
  const url = new URL(path, options.targetUrl.endsWith("/") ? options.targetUrl : `${options.targetUrl}/`);
  const res = await fetch(url, {
    method: options.action === "add" ? "PUT" : options.action === "delete" ? "DELETE" : "GET",
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...options.action === "add" ? { "Content-Type": "application/json" } : {}
    },
    body: options.action === "add" ? JSON.stringify({ password: options.password, access: options.access }) : void 0
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim() || `request failed: ${res.status}`);
  const result = JSON.parse(text);
  if (options.action === "list" && !Array.isArray(result.users)) throw new Error("invalid user list response");
  return result;
}
async function parseWorkerArgs(args, io) {
  if (args[0] !== "deploy") return { error: "missing worker action: deploy" };
  let profile = "default";
  let workerName;
  let accountId;
  let adminToken;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--token-stdin") {
      if (adminToken) return { error: "duplicate admin credential source" };
      adminToken = { stdin: true };
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return { error: `missing value for ${arg}` };
    index += 1;
    if (arg === "--profile") profile = value;
    else if (arg === "--name") workerName = value;
    else if (arg === "--account-id") {
      if (!/^[0-9a-f]{32}$/i.test(value)) return { error: "invalid --account-id" };
      accountId = value;
    } else if (arg === "--token-env") {
      if (adminToken) return { error: "duplicate admin credential source" };
      const source = envSecret(value);
      if (!source) return { error: `invalid environment variable name: ${value}` };
      adminToken = source;
    } else return { error: `unknown option: ${arg}` };
  }
  let adminSecret;
  try {
    if (adminToken) adminSecret = await readSecret(adminToken, io);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { action: "deploy", options: { profile, workerName, accountId, adminSecret } };
}
async function parseMigrateArgs(args, defaultRepoPath, io) {
  const sourceHeaderSources = [];
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
    if (arg === "--token-stdin") {
      if (targetToken) return { error: "duplicate token source" };
      targetToken = { stdin: true };
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return { error: `missing value for ${arg}` };
    index += 1;
    if (arg === "--repo") repoPath = value;
    else if (arg === "--source-url") sourceUrl = value;
    else if (arg === "--target") targetUrl = value;
    else if (arg === "--token-env") {
      if (targetToken) return { error: "duplicate token source" };
      const source = envSecret(value);
      if (!source) return { error: `invalid environment variable name: ${value}` };
      targetToken = source;
    } else if (arg === "--concurrency") {
      concurrency = Number(value);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) return { error: "invalid --concurrency" };
    } else if (arg === "--source-header-env") {
      const source = envSecret(value);
      if (!source) return { error: `invalid environment variable name: ${value}` };
      sourceHeaderSources.push(source);
    } else return { error: `unknown option: ${arg}` };
  }
  if (!targetUrl) return { error: "missing required option: --target" };
  if (!targetToken) return { error: "missing required option: --token-env or --token-stdin" };
  try {
    assertSafeUrl(targetUrl, true);
    if (sourceUrl) assertSafeUrl(sourceUrl, sourceHeaderSources.length > 0);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const sourceHeaders = {};
    for (const source of sourceHeaderSources) {
      const header = parseHeader(await readSecret(source, io));
      if (!header) return { error: "invalid --source-header-env value" };
      sourceHeaders[header.name] = header.value;
    }
    return { options: { repoPath, sourceUrl, sourceHeaders, targetUrl, targetToken: await readSecret(targetToken, io), concurrency, dryRun, writeConfig } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
function envSecret(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? { env: name } : null;
}
function isStdinSecret(source) {
  return "stdin" in source;
}
async function readSecret(source, io) {
  if ("value" in source) return source.value;
  if ("env" in source) {
    const value2 = (io.env ?? process.env)[source.env];
    if (!value2) throw new Error(`missing environment variable: ${source.env}`);
    return value2;
  }
  const value = await (io.readStdin ?? readStdin)();
  const secret = value.replace(/\r?\n$/, "");
  if (!secret) throw new Error("standard input secret is empty");
  return secret;
}
async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  return value;
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
  worker   deploy a zero-config git-me Worker
  user     manage git-me LFS users
  migrate  migrate Git LFS objects to git-me
`;
}
function migrateUsage() {
  return `Usage: git-me migrate --target <url> (--token-env <name>|--token-stdin) [options]

Options:
  --repo <path>                  repository path (default: current directory)
  --source-url <url>             source LFS URL (default: git config lfs.url)
  --source-header-env <name>     env var containing name: value, repeatable
  --concurrency <number>         concurrent transfers, 1..16 (default: 4)
  --dry-run                      scan without transferring objects
  --write-config                 update lfs.url after successful migration
`;
}
function userUsage() {
  return `Usage: git-me user <add|delete> [username] [options]
       git-me user list [options]

Options:
  --profile <name>       local profile (default: default)
  --target <url>         Worker URL (default: saved profile)
  --token-env <name>     env var containing admin token
  --token-stdin          read admin token from standard input
  --password-env <name>  env var containing password for add
  --password-stdin       read password for add from standard input
  --access <read|write>  access for add (default: read)
  --yes                  skip delete confirmation
  --json                 output user list as JSON
`;
}
function workerUsage() {
  return `Usage: git-me worker deploy [options]

Options:
  --profile <name>       local profile name (default: default)
  --name <name>          Worker name (default: generated)
  --account-id <id>      Cloudflare account ID
  --token-stdin          use an admin secret from standard input
  --token-env <name>     use an admin secret from an environment variable
`;
}
function formatResult(result) {
  const lines = [`scanned=${result.scanned} unique=${result.unique} migrated=${result.migrated} skipped=${result.skipped} failed=${result.failed.length}`];
  for (const failure of result.failed) lines.push(`${failure.oid}: ${failure.reason}`);
  return `${lines.join("\n")}
`;
}
function formatUserResult(result, jsonOutput = false) {
  if (result.users) {
    if (jsonOutput) return `${JSON.stringify(result.users)}
`;
    if (result.users.length === 0) return "USERNAME  ACCESS\n";
    const width = Math.max("USERNAME".length, ...result.users.map((user) => user.username.length));
    return [`${"USERNAME".padEnd(width)}  ACCESS`, ...result.users.map((user) => `${user.username.padEnd(width)}  ${user.access}`)].join("\n") + "\n";
  }
  if (result.deleted) return `username=${result.username} deleted=true
`;
  return `username=${result.username} access=${result.access}
`;
}
async function confirmPrompt(prompt) {
  const value = await ioReadLine(prompt);
  return /^y(?:es)?$/i.test(value.trim());
}
async function ioReadLine(prompt) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
async function readPassword(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("password prompt unavailable; use --password-stdin");
  const stdin = process.stdin;
  const stdout = process.stdout;
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise((resolve2, reject) => {
    const bytes = [];
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error("password prompt cancelled"));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          stdout.write("\n");
          resolve2(Buffer.from(bytes).toString("utf8"));
          return;
        }
        if (byte === 127 || byte === 8) {
          removeLastUtf8CodePoint(bytes);
          continue;
        }
        bytes.push(byte);
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}
function removeLastUtf8CodePoint(bytes) {
  if (bytes.length === 0) return;
  let index = bytes.length - 1;
  while (index > 0 && ((bytes[index] ?? 0) & 192) === 128) index -= 1;
  bytes.splice(index);
}
function isMainEntry() {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath2(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainEntry()) {
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
