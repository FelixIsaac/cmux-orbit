import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
      content,
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

export function listRecentDirectories(activeWorkspaceDirs: string[]): { label: string; path: string }[] {
  const dirs = new Set<string>();
  for (const d of activeWorkspaceDirs) {
    if (d && existsSync(d)) dirs.add(d);
  }
  const projectsDir = join(HOME, "Projects");
  if (existsSync(projectsDir)) {
    dirs.add(projectsDir);
    try {
      for (const entry of readdirSync(projectsDir)) {
        if (entry.startsWith(".")) continue;
        const full = join(projectsDir, entry);
        try {
          if (statSync(full).isDirectory()) dirs.add(full);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  const obsidian = join(HOME, "Documents/Obsidian Vault");
  if (existsSync(obsidian)) dirs.add(obsidian);

  return Array.from(dirs)
    .slice(0, 18)
    .map((p) => ({
      path: p,
      label: p.replace(HOME, "~"),
    }));
}
