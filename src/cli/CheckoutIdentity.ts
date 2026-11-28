import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"

const SHA40_RE = /^[0-9a-f]{40}$/i
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export type CommitIdentitySource = "jj" | "git" | "env" | "uncommitted"
export type RepositoryIdentitySource =
  | "jj-remote"
  | "git-config"
  | "package-json"
  | "env"
  | "local-directory"

export interface CheckoutIdentity {
  readonly repository: string
  readonly repositorySource: RepositoryIdentitySource
  readonly commitSha: string
  readonly commitSource: CommitIdentitySource
  readonly commitVerified: boolean
  readonly dirty: boolean | null
  readonly ref: string | null
  readonly envCommitMismatch: string | null
}

function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback
}

/**
 * Extracts a sanitized `owner/repo` slug from a remote URL or package repository field.
 * Strips any embedded URL credentials and never returns raw URLs or tokens.
 */
export function parseRepositorySlug(raw: string): string | null {
  const trimmed = String(raw ?? "").trim()
  if (!trimmed) return null

  const normalized = trimmed.replace(/^git\+/, "")
  if (REPO_RE.test(normalized)) {
    return normalized.replace(/\.git$/i, "").toLowerCase()
  }

  // Handle github:owner/repo shorthand
  if (/^github:/i.test(normalized)) {
    const slug = normalized.slice("github:".length).replace(/^\/+/, "").replace(/\.git$/i, "")
    return REPO_RE.test(slug) ? slug.toLowerCase() : null
  }

  // Handle SCP-style SSH URL: [user@]host:owner/repo(.git)
  const scpMatch = /^(?:[^@/\s]+@)?[^:/\s]+:([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(normalized)
  if (scpMatch?.[1]) {
    const slug = scpMatch[1].replace(/\.git$/i, "")
    return REPO_RE.test(slug) ? slug.toLowerCase() : null
  }

  // Handle HTTP(S) / SSH URLs safely via URL parser (discarding username/password)
  try {
    const parsed = new URL(normalized)
    const parts = parsed.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean)
    if (parts.length >= 2) {
      const slug = `${parts[0]}/${parts[1]}`
      return REPO_RE.test(slug) ? slug.toLowerCase() : null
    }
  } catch {
    // Not a valid URL
  }

  return null
}

function findAncestorWith(startDir: string, entryName: string): string | null {
  let cursor = resolve(startDir)
  for (;;) {
    if (existsSync(join(cursor, entryName))) {
      return cursor
    }
    const parent = dirname(cursor)
    if (parent === cursor) return null
    cursor = parent
  }
}

function resolveGitDirs(repoDir: string): { readonly gitDir: string; readonly commonDir: string } | null {
  const dotGitPath = join(repoDir, ".git")
  if (!existsSync(dotGitPath)) return null

  let gitDir: string
  try {
    const st = lstatSync(dotGitPath)
    if (st.isDirectory()) {
      gitDir = dotGitPath
    } else if (st.isFile()) {
      const text = readFileSync(dotGitPath, "utf8").trim()
      const match = /^gitdir:\s*(.+)$/i.exec(text)
      if (!match?.[1]) return null
      gitDir = resolve(repoDir, match[1].trim())
    } else {
      return null
    }
  } catch {
    return null
  }

  let commonDir = gitDir
  const commonDirFile = join(gitDir, "commondir")
  if (existsSync(commonDirFile)) {
    try {
      const relCommon = readFileSync(commonDirFile, "utf8").trim()
      if (relCommon) {
        commonDir = resolve(gitDir, relCommon)
      }
    } catch {
      // Keep gitDir
    }
  }

  return { gitDir, commonDir }
}

function readPackedRef(packedRefsPath: string, refName: string): string | null {
  if (!existsSync(packedRefsPath)) return null
  try {
    const lines = readFileSync(packedRefsPath, "utf8").split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue
      const spaceIdx = trimmed.indexOf(" ")
      if (spaceIdx === -1) continue
      const sha = trimmed.slice(0, spaceIdx)
      const name = trimmed.slice(spaceIdx + 1).trim()
      if (name === refName && SHA40_RE.test(sha)) {
        return sha.toLowerCase()
      }
    }
  } catch {
    // Ignore unreadable packed-refs
  }
  return null
}

function resolveGitHeadFromFs(repoDir: string): { readonly commitSha: string; readonly ref: string | null } | null {
  const dirs = resolveGitDirs(repoDir)
  if (!dirs) return null
  const headPath = join(dirs.gitDir, "HEAD")
  if (!existsSync(headPath)) return null

  let headText: string
  try {
    headText = readFileSync(headPath, "utf8").trim()
  } catch {
    return null
  }

  if (SHA40_RE.test(headText)) {
    return { commitSha: headText.toLowerCase(), ref: null }
  }

  if (!headText.startsWith("ref:")) return null
  const refName = headText.slice(4).trim()
  if (
    !refName ||
    refName.startsWith("/") ||
    refName.includes("..") ||
    refName.includes("\0") ||
    refName.includes("\\")
  ) {
    return null
  }

  for (const baseDir of [dirs.gitDir, dirs.commonDir]) {
    const loosePath = resolve(baseDir, refName)
    if (loosePath.startsWith(`${baseDir}${sep}`) && existsSync(loosePath)) {
      try {
        const refSha = readFileSync(loosePath, "utf8").trim()
        if (SHA40_RE.test(refSha)) {
          return { commitSha: refSha.toLowerCase(), ref: refName }
        }
      } catch {
        // Continue to packed-refs
      }
    }
  }

  const packed =
    readPackedRef(join(dirs.gitDir, "packed-refs"), refName) ??
    (dirs.commonDir !== dirs.gitDir ? readPackedRef(join(dirs.commonDir, "packed-refs"), refName) : null)
  if (packed) {
    return { commitSha: packed, ref: refName }
  }

  return null
}

function readGitConfigRemoteSlug(repoDir: string): string | null {
  const dirs = resolveGitDirs(repoDir)
  if (!dirs) return null
  const configPath = join(dirs.commonDir, "config")
  if (!existsSync(configPath)) return null

  let text: string
  try {
    text = readFileSync(configPath, "utf8")
  } catch {
    return null
  }

  let currentRemote: string | null = null
  let originSlug: string | null = null
  let fallbackSlug: string | null = null

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line)
    if (sectionMatch?.[1]) {
      const remoteMatch = /^remote\s+"([^"]+)"$/i.exec(sectionMatch[1].trim())
      currentRemote = remoteMatch?.[1] ?? null
      continue
    }
    if (!currentRemote) continue
    const urlMatch = /^url\s*=\s*(.+)$/i.exec(line)
    if (!urlMatch?.[1]) continue
    const slug = parseRepositorySlug(urlMatch[1])
    if (!slug) continue
    if (currentRemote === "origin") {
      originSlug = slug
      break
    }
    if (!fallbackSlug) {
      fallbackSlug = slug
    }
  }

  return originSlug ?? fallbackSlug
}

function resolveJjCommit(
  jjRoot: string,
  env: NodeJS.ProcessEnv
): { readonly commitSha: string; readonly dirty: boolean; readonly ref: string | null } | null {
  try {
    const raw = execFileSync(
      "jj",
      [
        "log",
        "--no-graph",
        "--ignore-working-copy",
        "-R",
        jjRoot,
        "-r",
        "@",
        "-T",
        "commit_id ++ \"\\n\" ++ empty ++ \"\\n\" ++ description.first_line() ++ \"\\n\" ++ parents.map(|p| p.commit_id()).join(\",\") ++ \"\\n\" ++ local_bookmarks.map(|b| b.name()).join(\",\")"
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    const lines = raw.split(/\r?\n/)
    const wcCommit = (lines[0] ?? "").trim()
    const wcEmpty = (lines[1] ?? "").trim() === "true"
    const wcDesc = (lines[2] ?? "").trim()
    const parents = (lines[3] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => SHA40_RE.test(s))
    const wcBookmarks = (lines[4] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)

    // In jj, a clean checkout sits on an empty, undescribed working-copy commit (@)
    // whose single parent (@-) is the actual checked-out source commit.
    if (wcEmpty && wcDesc.length === 0 && parents.length === 1 && parents[0]) {
      let parentRef: string | null = null
      try {
        const parentBookmarks = execFileSync(
          "jj",
          [
            "log",
            "--no-graph",
            "--ignore-working-copy",
            "-R",
            jjRoot,
            "-r",
            "@-",
            "-T",
            "local_bookmarks.map(|b| b.name()).join(\",\")"
          ],
          { encoding: "utf8", timeout: 3000, env, stdio: ["ignore", "pipe", "pipe"] }
        )
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
        parentRef = parentBookmarks[0] ?? null
      } catch {
        parentRef = null
      }
      return {
        commitSha: parents[0].toLowerCase(),
        dirty: false,
        ref: parentRef
      }
    }

    if (SHA40_RE.test(wcCommit)) {
      return {
        commitSha: wcCommit.toLowerCase(),
        dirty: !wcEmpty,
        ref: wcBookmarks[0] ?? null
      }
    }
  } catch {
    // jj unavailable or repository unreadable; fall back to pure-fs .git detection
  }
  return null
}

function resolveJjRemoteSlug(jjRoot: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const raw = execFileSync("jj", ["git", "remote", "list", "--ignore-working-copy", "-R", jjRoot], {
      encoding: "utf8",
      timeout: 5000,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let fallback: string | null = null
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const spaceIdx = trimmed.indexOf(" ")
      if (spaceIdx === -1) continue
      const remoteName = trimmed.slice(0, spaceIdx).trim()
      const remoteUrl = trimmed.slice(spaceIdx + 1).trim()
      const slug = parseRepositorySlug(remoteUrl)
      if (!slug) continue
      if (remoteName === "origin") return slug
      if (!fallback) fallback = slug
    }
    return fallback
  } catch {
    return null
  }
}

function readPackageJsonRepository(repoRoot: string): string | null {
  const pkgPath = join(repoRoot, "package.json")
  if (!existsSync(pkgPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      repository?: string | { url?: string }
    }
    if (typeof parsed.repository === "string") {
      return parseRepositorySlug(parsed.repository)
    }
    if (parsed.repository && typeof parsed.repository.url === "string") {
      return parseRepositorySlug(parsed.repository.url)
    }
  } catch {
    // Ignore malformed package.json
  }
  return null
}

/**
 * Resolves the actual checkout commit SHA and repository identity from jj or pure-fs .git
 * metadata without ever calling the git CLI or falling back to a hardcoded example commit.
 */
export function resolveCheckoutIdentity(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): CheckoutIdentity {
  const resolvedRoot = resolve(repoRoot)
  const jjRoot = findAncestorWith(resolvedRoot, ".jj")
  const gitRoot = findAncestorWith(resolvedRoot, ".git")

  const envShaRaw = (env.SMITHERS_COMMIT_SHA ?? env.GITHUB_SHA ?? "").trim()
  const envSha = SHA40_RE.test(envShaRaw) ? envShaRaw.toLowerCase() : null

  let commitSha: string | null = null
  let commitSource: CommitIdentitySource = "uncommitted"
  let commitVerified = false
  let dirty: boolean | null = null
  let ref: string | null = null

  if (jjRoot) {
    const jjInfo = resolveJjCommit(jjRoot, env)
    if (jjInfo) {
      commitSha = jjInfo.commitSha
      commitSource = "jj"
      commitVerified = true
      dirty = jjInfo.dirty
      ref = jjInfo.ref
    }
  }

  if (!commitSha && gitRoot) {
    const gitInfo = resolveGitHeadFromFs(gitRoot)
    if (gitInfo) {
      commitSha = gitInfo.commitSha
      commitSource = "git"
      commitVerified = true
      ref = gitInfo.ref
    }
  }

  let envCommitMismatch: string | null = null
  if (commitSha && commitVerified) {
    if (envSha && envSha !== commitSha) {
      envCommitMismatch = envSha
    }
  } else if (envSha) {
    commitSha = envSha
    commitSource = "env"
    commitVerified = false
  } else {
    commitSha = "uncommitted-workspace"
    commitSource = "uncommitted"
    commitVerified = false
  }

  let repository: string | null = null
  let repositorySource: RepositoryIdentitySource = "local-directory"

  if (jjRoot) {
    const jjSlug = resolveJjRemoteSlug(jjRoot, env)
    if (jjSlug) {
      repository = jjSlug
      repositorySource = "jj-remote"
    }
  }

  if (!repository && gitRoot) {
    const gitSlug = readGitConfigRemoteSlug(gitRoot)
    if (gitSlug) {
      repository = gitSlug
      repositorySource = "git-config"
    }
  }

  if (!repository) {
    const pkgSlug = readPackageJsonRepository(resolvedRoot)
    if (pkgSlug) {
      repository = pkgSlug
      repositorySource = "package-json"
    }
  }

  if (!repository) {
    const envRepo = (env.SMITHERS_REPOSITORY ?? env.GITHUB_REPOSITORY ?? "").trim()
    const envSlug = parseRepositorySlug(envRepo)
    if (envSlug) {
      repository = envSlug
      repositorySource = "env"
    }
  }

  if (!repository) {
    repository = `local/${sanitizeSegment(basename(resolvedRoot), "workspace")}`
    repositorySource = "local-directory"
  }

  return {
    repository,
    repositorySource,
    commitSha,
    commitSource,
    commitVerified,
    dirty,
    ref,
    envCommitMismatch
  }
}
