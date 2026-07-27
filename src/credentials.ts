import { execFile } from 'node:child_process';
import { platform } from 'node:os';

export type CredentialStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

const SERVICE = 'git-me';

export function createCredentialStore(): CredentialStore {
  return new SystemCredentialStore();
}

class SystemCredentialStore implements CredentialStore {
  async get(key: string): Promise<string | null> {
    const os = platform();
    if (os === 'darwin') return await macGet(key);
    if (os === 'linux') return await linuxGet(key);
    if (os === 'win32') return await windowsGet(key);
    throw new Error(`credential store unsupported on ${os}`);
  }

  async set(key: string, value: string): Promise<void> {
    if (!value) throw new Error('credential cannot be empty');
    const os = platform();
    if (os === 'darwin') return await macSet(key, value);
    if (os === 'linux') return await linuxSet(key, value);
    if (os === 'win32') return await windowsSet(key, value);
    throw new Error(`credential store unsupported on ${os}`);
  }

  async delete(key: string): Promise<void> {
    const os = platform();
    if (os === 'darwin') return await macDelete(key);
    if (os === 'linux') return await linuxDelete(key);
    if (os === 'win32') return await windowsDelete(key);
    throw new Error(`credential store unsupported on ${os}`);
  }
}

async function macGet(key: string): Promise<string | null> {
  const result = await run('security', ['find-generic-password', '-a', SERVICE, '-s', key, '-w'], undefined, true);
  return result?.trim() || null;
}

async function macSet(key: string, value: string): Promise<void> {
  await run('security', ['add-generic-password', '-U', '-a', SERVICE, '-s', key, '-w'], value);
}

async function macDelete(key: string): Promise<void> {
  await run('security', ['delete-generic-password', '-a', SERVICE, '-s', key], undefined, true);
}

async function linuxGet(key: string): Promise<string | null> {
  const result = await run('secret-tool', ['lookup', 'service', SERVICE, 'profile', key], undefined, true);
  return result?.trim() || null;
}

async function linuxSet(key: string, value: string): Promise<void> {
  await run('secret-tool', ['store', '--label=git-me credential', 'service', SERVICE, 'profile', key], value);
}

async function linuxDelete(key: string): Promise<void> {
  await run('secret-tool', ['clear', 'service', SERVICE, 'profile', key], undefined, true);
}

// Windows Credential Manager is called through PowerShell's native Cred* API.
// The command receives the secret on stdin, so it never appears in a process
// argument or a local config file.
async function windowsGet(key: string): Promise<string | null> {
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
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, key], undefined, true);
  return result?.trim() || null;
}

async function windowsSet(key: string, value: string): Promise<void> {
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
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, key], value);
}

async function windowsDelete(key: string): Promise<void> {
  const script = `${windowsCredentialApi()}
[WinCred]::CredDelete($args[0], 1, 0) | Out-Null`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, key], undefined, true);
}

function windowsCredentialApi(): string {
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

function run(command: string, args: string[], input?: string, ignoreFailure = false): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        if (ignoreFailure) return resolve(null);
        reject(new Error(`credential store unavailable: ${stderr.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}
