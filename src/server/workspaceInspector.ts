import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface GitFileDiff {
  path: string;
  status: "M" | "A" | "D" | "U" | "?";
  additions: number;
  deletions: number;
  patch: string;
}

export interface GitWorkspaceSummary {
  isGitRepo: boolean;
  cwd: string;
  branch?: string;
  clean: boolean;
  totalAdditions: number;
  totalDeletions: number;
  files: GitFileDiff[];
}

export interface FilePreviewResult {
  ok: boolean;
  path: string;
  name: string;
  content: string;
  size: number;
  modifiedAt: string;
  error?: string;
}

const HOME = homedir();

const SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_\-]{20,}/g, // Anthropic API keys
  /sk-(?:proj-|live-|test-)?[a-zA-Z0-9_\-]{24,}/g, // OpenAI API keys
  /gh[pousr]_[a-zA-Z0-9]{30,}/g, // GitHub PATs
  /github_pat_[a-zA-Z0-9_]{30,}/g, // GitHub fine-grained PAT
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g, // AWS Access Key ID
  /-----BEGIN (?:[A-Z0-9 ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+)?PRIVATE KEY-----/g, // Private keys
  /(?:Bearer\s+)[a-zA-Z0-9\-_.]+\.[a-zA-Z0-9\-_.]+/gi, // Bearer tokens
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  let sanitized = text;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED SECRET]");
  }
  return sanitized;
}

export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function isPathSafeAndAllowed(targetPath: string): { ok: boolean; error?: string } {
  if (targetPath.includes("\0")) {
    return { ok: false, error: "Invalid path: null bytes forbidden" };
  }
  let p = targetPath.trim();
  if (p.startsWith("~/")) {
    p = join(HOME, p.slice(2));
  }
  const resolved = resolve(p);

  // Check realpath if it exists to prevent symlink traversal
  let canonical = resolved;
  try {
    if (existsSync(resolved)) {
      canonical = realpathSync(resolved);
    }
  } catch {}

  const lower = canonical.toLowerCase();
  const lowerBase = basename(canonical).toLowerCase();

  // Block root system directories
  if (
    lower.startsWith("/etc") ||
    lower.startsWith("/private/etc") ||
    lower.startsWith("/var") ||
    lower.startsWith("/private/var") ||
    lower.startsWith("/system") ||
    lower.startsWith("/library/keychains")
  ) {
    return { ok: false, error: "Access to system directory denied" };
  }

  // Block sensitive credential directories in HOME
  const blockedDirs = [
    join(HOME, ".ssh").toLowerCase(),
    join(HOME, ".aws").toLowerCase(),
    join(HOME, ".gnupg").toLowerCase(),
    join(HOME, ".config/gcloud").toLowerCase(),
    join(HOME, ".local/state/cmux-orbit").toLowerCase(),
  ];

  for (const b of blockedDirs) {
    if (lower === b || lower.startsWith(b + "/")) {
      return { ok: false, error: "Access to credential directory denied" };
    }
  }

  // Block sensitive filenames
  if (
    lowerBase === ".env" ||
    lowerBase.startsWith(".env.") ||
    lowerBase === "credentials" ||
    lowerBase === "id_rsa" ||
    lowerBase === "id_ed25519" ||
    lowerBase === "id_ecdsa" ||
    lowerBase === "authorized_keys" ||
    lowerBase.endsWith(".pem") ||
    lowerBase.endsWith(".key") ||
    lowerBase.endsWith(".p12") ||
    lowerBase.endsWith(".pfx")
  ) {
    return { ok: false, error: "Access to sensitive credential file denied" };
  }

  // Containment: must reside inside HOME or explicit workspace roots
  if (!lower.startsWith(HOME.toLowerCase() + "/") && lower !== HOME.toLowerCase()) {
    return { ok: false, error: "Access outside home directory denied" };
  }

  return { ok: true };
}

export function resolveSafeFilePath(rawPath: string, baseCwd?: string): string {
  let p = rawPath.trim();
  if (p.startsWith("~/")) {
    p = join(HOME, p.slice(2));
  } else if (!isAbsolute(p) && baseCwd) {
    p = resolve(baseCwd, p);
  }
  return resolve(p);
}

export function readFilePreview(rawPath: string, baseCwd?: string, maxBytes = 250 * 1024): FilePreviewResult {
  const fullPath = resolveSafeFilePath(rawPath, baseCwd);
  const safety = isPathSafeAndAllowed(fullPath);
  if (!safety.ok) {
    return {
      ok: false,
      path: fullPath,
      name: basename(fullPath),
      content: "",
      size: 0,
      modifiedAt: "",
      error: safety.error || "Access denied",
    };
  }

  if (!existsSync(fullPath)) {
    return {
      ok: false,
      path: fullPath,
      name: basename(fullPath),
      content: "",
      size: 0,
      modifiedAt: "",
      error: "File does not exist",
    };
  }
  try {
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      const entries = readdirSync(fullPath).slice(0, 100);
      return {
        ok: true,
        path: fullPath,
        name: basename(fullPath),
        content: entries.map((e) => `- ${e}`).join("\n"),
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
      };
    }
    const raw = readFileSync(fullPath, "utf8");
    const content =
      raw.length > maxBytes
        ? raw.slice(0, maxBytes) + `\n\n... [Truncated — file is ${(st.size / 1024).toFixed(1)} KB]`
        : raw;
    return {
      ok: true,
      path: fullPath,
      name: basename(fullPath),
      content: redactSecrets(content),
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
    };
  } catch (err: any) {
    return {
      ok: false,
      path: fullPath,
      name: basename(fullPath),
      content: "",
      size: 0,
      modifiedAt: "",
      error: err?.message || "Failed to read file",
    };
  }
}

async function runCmd(cmd: string[], cwd: string, timeoutMs = 2500): Promise<{ exitCode: number; stdout: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);
    const out = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { exitCode, stdout: out };
  } catch {
    return { exitCode: 1, stdout: "" };
  }
}

export async function inspectGitWorkspace(cwd?: string): Promise<GitWorkspaceSummary> {
  if (!cwd || !existsSync(cwd)) {
    return {
      isGitRepo: false,
      cwd: cwd || "",
      clean: true,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
    };
  }

  const branchRes = await runCmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branchRes.exitCode !== 0) {
    return {
      isGitRepo: false,
      cwd,
      clean: true,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
    };
  }

  const branch = branchRes.stdout.trim();
  const statusRes = await runCmd(["git", "status", "--porcelain"], cwd);
  const diffRes = await runCmd(["git", "diff", "--no-color", "HEAD"], cwd, 3000);

  // Parse unified diff by file
  const patchByFile = new Map<string, { additions: number; deletions: number; patch: string }>();
  const rawDiff = diffRes.stdout.slice(0, 180 * 1024);
  const chunks = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const chunk of chunks) {
    const firstLineEnd = chunk.indexOf("\n");
    if (firstLineEnd === -1) continue;
    const header = chunk.slice(0, firstLineEnd);
    const bMatch = header.match(/ b\/(.+)$/);
    const filePath = bMatch ? bMatch[1].trim() : header.trim();
    const body = chunk.slice(firstLineEnd + 1);
    let additions = 0;
    let deletions = 0;
    for (const ln of body.split("\n")) {
      if (ln.startsWith("+") && !ln.startsWith("+++")) additions++;
      else if (ln.startsWith("-") && !ln.startsWith("---")) deletions++;
    }
    patchByFile.set(filePath, {
      additions,
      deletions,
      patch: body.slice(0, 12000),
    });
  }

  const files: GitFileDiff[] = [];
  const seenPaths = new Set<string>();

  for (const line of statusRes.stdout.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2).trim();
    const filePath = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
    seenPaths.add(filePath);
    const diffInfo = patchByFile.get(filePath);
    let status: GitFileDiff["status"] = "M";
    if (code.includes("?")) status = "?";
    else if (code.includes("A")) status = "A";
    else if (code.includes("D")) status = "D";
    else if (code.includes("U")) status = "U";

    files.push({
      path: filePath,
      status,
      additions: diffInfo?.additions || 0,
      deletions: diffInfo?.deletions || 0,
      patch: diffInfo?.patch || "",
    });
  }

  for (const [filePath, diffInfo] of patchByFile.entries()) {
    if (!seenPaths.has(filePath)) {
      files.push({
        path: filePath,
        status: "M",
        additions: diffInfo.additions,
        deletions: diffInfo.deletions,
        patch: diffInfo.patch,
      });
    }
  }

  const totalAdditions = files.reduce((acc, f) => acc + f.additions, 0);
  const totalDeletions = files.reduce((acc, f) => acc + f.deletions, 0);

  return {
    isGitRepo: true,
    cwd,
    branch,
    clean: files.length === 0,
    totalAdditions,
    totalDeletions,
    files: files.slice(0, 40),
  };
}

export interface ProjectDirectoryEntry {
  path: string;
  name: string;
  shortPath: string;
  label: string;
  category: "workspace" | "project" | "vault" | "folder";
  icon: string;
  isGitRepo?: boolean;
}

export function formatDirectoryEntry(p: string, isWorkspace = false): ProjectDirectoryEntry {
  const norm = p.replace(/\/+$/, "");
  const base = basename(norm) || norm;

  let shortPath = norm.replace(HOME, "~");
  if (shortPath.includes("Library/CloudStorage/GoogleDrive-")) {
    shortPath = shortPath.replace(/~\/Library\/CloudStorage\/GoogleDrive-[^/]+\/My Drive/, "~/GDrive");
  } else if (shortPath.includes("Library/CloudStorage/OneDrive-")) {
    shortPath = shortPath.replace(/~\/Library\/CloudStorage\/OneDrive-[^/]+/, "~/OneDrive");
  } else if (shortPath.includes("Library/Mobile Documents/com~apple~CloudDocs")) {
    shortPath = shortPath.replace(/~\/Library\/Mobile Documents\/com~apple~CloudDocs/, "~/iCloud");
  }

  let category: ProjectDirectoryEntry["category"] = "folder";
  let icon = "📁";

  if (norm.includes("Obsidian")) {
    category = "vault";
    icon = "📓";
  } else if (isWorkspace) {
    category = "workspace";
    icon = "⚡";
  } else if (norm.includes("/Projects/")) {
    category = "project";
    icon = "📁";
  }

  let isGit = false;
  try {
    isGit = existsSync(join(norm, ".git"));
  } catch {}

  return {
    path: norm,
    name: base,
    shortPath,
    label: base,
    category,
    icon,
    isGitRepo: isGit,
  };
}

export function listRecentDirectories(activeWorkspaceDirs: string[]): ProjectDirectoryEntry[] {
  const seenPaths = new Set<string>();
  const results: ProjectDirectoryEntry[] = [];

  for (const d of activeWorkspaceDirs) {
    if (d && existsSync(d) && !seenPaths.has(d)) {
      seenPaths.add(d);
      results.push(formatDirectoryEntry(d, true));
    }
  }

  const projectsDir = join(HOME, "Projects");
  if (existsSync(projectsDir)) {
    try {
      for (const entry of readdirSync(projectsDir)) {
        if (entry.startsWith(".")) continue;
        const full = join(projectsDir, entry);
        if (!seenPaths.has(full)) {
          try {
            if (statSync(full).isDirectory()) {
              seenPaths.add(full);
              results.push(formatDirectoryEntry(full, false));
            }
          } catch {}
        }
      }
    } catch {}
  }

  const obsidian = join(HOME, "Documents/Obsidian Vault");
  if (existsSync(obsidian) && !seenPaths.has(obsidian)) {
    seenPaths.add(obsidian);
    results.push(formatDirectoryEntry(obsidian, false));
  }

  return results.slice(0, 20);
}
