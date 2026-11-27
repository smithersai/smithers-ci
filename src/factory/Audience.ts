import { DEFAULT_MAINTAINERS } from "../trust/ExecutionTrust.ts"

export type AudienceRole = "maintainer" | "contributor" | "viewer"
export type HomeSectionAudience = "maintainer" | "contributor" | "everyone"

export interface UserProfile {
  readonly login: string | null
  readonly contributions: number // merged commits, PRs, or accepted issues (>= 1 => contributor)
  readonly maintainers?: ReadonlyArray<string>
}

export interface AudienceResolution {
  readonly role: AudienceRole
  readonly homeAudience: HomeSectionAudience
  readonly allowedViewAs: ReadonlyArray<AudienceRole>
  readonly label: string
  readonly badge: string
  readonly contributions: number
}

/**
 * Resolves the personalized factory audience:
 * - Maintainer: authenticated listed repository maintainer (roninjin10)
 * - Contributor: authenticated non-maintainer who has contributed at least 1 thing (contributions >= 1)
 * - Viewer: everyone else (0 contributions or signed out)
 */
export function resolveAudience(profile: UserProfile): AudienceResolution {
  const maintainers = new Set(
    (profile.maintainers ?? DEFAULT_MAINTAINERS).map((m) => String(m).trim().toLowerCase())
  )
  const login = typeof profile.login === "string" && profile.login.trim().length > 0
    ? profile.login.trim().toLowerCase()
    : null
  const contributions =
    typeof profile.contributions === "number" && Number.isFinite(profile.contributions)
      ? Math.max(0, Math.floor(profile.contributions))
      : 0

  if (login && maintainers.has(login)) {
    return {
      role: "maintainer",
      homeAudience: "maintainer",
      allowedViewAs: ["maintainer", "contributor", "viewer"],
      label: "Maintainer",
      badge: `${login} · Maintainer`,
      contributions: Math.max(contributions, 1)
    }
  }

  // Signed-out profiles can never escalate to contributor even if contributions > 0 is passed.
  if (login && contributions >= 1) {
    return {
      role: "contributor",
      homeAudience: "contributor",
      allowedViewAs: ["contributor", "viewer"],
      label: "Contributor",
      badge: `${login} · ${contributions} ${contributions === 1 ? "contribution" : "contributions"}`,
      contributions
    }
  }

  return {
    role: "viewer",
    homeAudience: "everyone",
    allowedViewAs: ["viewer"],
    label: "Viewer",
    badge: login ? `${login} · Viewer` : "Public Viewer",
    contributions: 0
  }
}

export function seesSection(viewer: HomeSectionAudience, sectionAudience: HomeSectionAudience): boolean {
  if (viewer === "maintainer") return true
  if (viewer === "contributor") return sectionAudience === "contributor" || sectionAudience === "everyone"
  return sectionAudience === "everyone"
}

export interface HomeValidationResult {
  readonly valid: boolean
  readonly reason: string | null
  readonly sectionsCount: number
  readonly blocksCount: number
  readonly audiences: ReadonlyArray<HomeSectionAudience>
}

const HTML_PATTERN = /<\/?[a-zA-Z!][^>]*>/
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/
const SAFE_RELATIVE_URL_PATTERN = /^\/(?!\/)[^\s"'<>\\]*$/
const SAFE_MD_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\:?#\r\n\t]+$/
const ENCODED_TRAVERSAL_PATTERN = /%(?:2e|2f|5c)/i
const ONE_LINE_MAX_TITLE = 120
const ONE_LINE_MAX_SHORT = 280
const MAX_CODE_OR_TEXT = 4096

const ALLOWED_LIVE_BLOCK_TYPES = new Set([
  "action",
  "issues",
  "stack",
  "runs",
  "flows",
  "prompt",
  "app",
  "view",
  "divider",
  "badges"
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasHtml(s: string): boolean {
  return HTML_PATTERN.test(s)
}

function isOneLine(s: string, maxLen: number): boolean {
  return s.length >= 1 && s.length <= maxLen && !/[\r\n]/.test(s) && !CONTROL_CHAR_PATTERN.test(s) && !hasHtml(s)
}

function isSafeHttpsUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return false
  if (CONTROL_CHAR_PATTERN.test(url) || hasHtml(url) || /\s/.test(url)) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.hostname.length > 0
  } catch {
    return false
  }
}

function isSafeUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return false
  if (CONTROL_CHAR_PATTERN.test(url) || hasHtml(url)) return false
  if (url.startsWith("/")) {
    return SAFE_RELATIVE_URL_PATTERN.test(url)
  }
  try {
    const parsed = new URL(url)
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname.length > 0
    )
  } catch {
    return false
  }
}

function isValidCalendarDate(dateStr: unknown): boolean {
  if (typeof dateStr !== "string") return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const dt = new Date(Date.UTC(year, month - 1, day))
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
}

/**
 * Validates `.smithers/home.json` against the `@smthrs/views` `Home.read` bounds
 * (apps/mvp/docs/features/home.md & packages/smithers/ui/views/docs/read-a-home.md).
 */
export function validateHomeJson(rawText: string): HomeValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return { valid: false, reason: "json: invalid JSON syntax", sectionsCount: 0, blocksCount: 0, audiences: [] }
  }

  if (!isPlainObject(parsed)) {
    return { valid: false, reason: "shape: root must be a JSON object", sectionsCount: 0, blocksCount: 0, audiences: [] }
  }

  const obj = parsed
  if ("sections" in obj && "blocks" in obj) {
    return { valid: false, reason: "shape: cannot declare both sections and blocks", sectionsCount: 0, blocksCount: 0, audiences: [] }
  }

  if ("docs" in obj && obj.docs !== undefined) {
    if (!isSafeHttpsUrl(obj.docs)) {
      return { valid: false, reason: "shape: docs must be a credential-free https URL", sectionsCount: 0, blocksCount: 0, audiences: [] }
    }
  }

  if ("contributors" in obj && obj.contributors !== undefined) {
    if (obj.contributors !== "role" && obj.contributors !== "anyone") {
      return { valid: false, reason: "shape: contributors must be role or anyone", sectionsCount: 0, blocksCount: 0, audiences: [] }
    }
  }

  const rawSections: ReadonlyArray<unknown> = Array.isArray(obj.sections)
    ? obj.sections
    : Array.isArray(obj.blocks)
      ? [{ audience: "everyone", blocks: obj.blocks }]
      : []

  if (rawSections.length === 0) {
    return { valid: false, reason: "shape: must declare sections or blocks array", sectionsCount: 0, blocksCount: 0, audiences: [] }
  }
  if (rawSections.length > 8) {
    return { valid: false, reason: "sections: exceeds maximum of 8 sections", sectionsCount: rawSections.length, blocksCount: 0, audiences: [] }
  }

  let totalBlocks = 0
  const audiences = new Set<HomeSectionAudience>()

  for (const section of rawSections) {
    if (!isPlainObject(section) || !Array.isArray(section.blocks)) {
      return { valid: false, reason: "section: each section must have a blocks array", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
    }
    const rawAud = section.audience ?? "everyone"
    if (rawAud !== "everyone" && rawAud !== "contributor" && rawAud !== "maintainer") {
      const audLabel = typeof rawAud === "string" ? rawAud.slice(0, 40) : typeof rawAud
      return { valid: false, reason: `section: invalid audience ${audLabel}`, sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
    }
    audiences.add(rawAud)

    if (section.title !== undefined && (typeof section.title !== "string" || !isOneLine(section.title, ONE_LINE_MAX_TITLE))) {
      return { valid: false, reason: "section: invalid title", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
    }

    for (const block of section.blocks) {
      totalBlocks += 1
      if (totalBlocks > 32) {
        return { valid: false, reason: "blocks: exceeds maximum of 32 total blocks", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
      }
      if (!isPlainObject(block) || typeof block.type !== "string" || block.type.length === 0 || CONTROL_CHAR_PATTERN.test(block.type)) {
        return { valid: false, reason: "block: missing or invalid block type", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
      }

      if (block.title !== undefined && (typeof block.title !== "string" || !isOneLine(block.title, ONE_LINE_MAX_TITLE))) {
        return { valid: false, reason: `block(${block.type}): invalid title`, sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
      }

      switch (block.type) {
        case "hero": {
          if (typeof block.title !== "string" || !isOneLine(block.title, ONE_LINE_MAX_TITLE)) {
            return { valid: false, reason: "block(hero): missing or invalid title", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
          }
          for (const field of ["tagline", "text", "install"] as const) {
            const val = block[field]
            if (val !== undefined && (typeof val !== "string" || !isOneLine(val, ONE_LINE_MAX_SHORT))) {
              return { valid: false, reason: `block(hero): invalid ${field}`, sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
            }
          }
          if (block.actions !== undefined) {
            if (!Array.isArray(block.actions) || block.actions.length === 0 || block.actions.length > 3) {
              return { valid: false, reason: "block(hero): actions must have 1 to 3 items", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
            }
            for (const act of block.actions) {
              if (!isPlainObject(act) || typeof act.label !== "string" || !isOneLine(act.label, ONE_LINE_MAX_TITLE) || !isSafeUrl(act.url)) {
                return { valid: false, reason: "block(hero): invalid action", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
              }
            }
          }
          break
        }
        case "code": {
          if (typeof block.code !== "string" || block.code.length === 0 || block.code.length > MAX_CODE_OR_TEXT || block.code.includes("\0")) {
            return { valid: false, reason: "block(code): invalid code", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
          }
          break
        }
        case "cards": {
          if (!Array.isArray(block.cards) || block.cards.length === 0 || block.cards.length > 12) {
            return { valid: false, reason: "block(cards): cards must have 1 to 12 entries", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
          }
          for (const card of block.cards) {
            if (!isPlainObject(card) || typeof card.title !== "string" || !isOneLine(card.title, ONE_LINE_MAX_TITLE)) {
              return { valid: false, reason: "block(cards): invalid card title", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
            }
            if (card.text !== undefined && (typeof card.text !== "string" || !isOneLine(card.text, ONE_LINE_MAX_SHORT))) {
              return { valid: false, reason: "block(cards): invalid card text", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
            }
            if (card.url !== undefined && !isSafeUrl(card.url)) {
              return { valid: false, reason: "block(cards): invalid card url", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
            }
          }
          break
        }
        case "stats": {
          if (!Array.isArray(block.stats) || block.stats.length === 0 || block.stats.length > 6) {
            return { valid: false, reason: "block(stats): stats must have 1 to 6 entries", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
          }
          for (const st of block.stats) {
            if (
              !isPlainObject(st) ||
              typeof st.value !== "string" ||
              !isOneLine(st.value, ONE_LINE_MAX_TITLE) ||
              typeof st.label !== "string" ||
              !isOneLine(st.label, ONE_LINE_MAX_TITLE)
            ) {
              return { valid: false, reason: "block(stats): invalid stat entry", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
            }
          }
          break
        }
        case "links": {
          if (!Array.isArray(block.links) || block.links.length === 0 || block.links.length > 12) {
            return { valid: false, reason: "block(links): links must have 1 to 12 entries", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
          }
          for (const lnk of block.links) {
            if (!isPlainObject(lnk) || typeof lnk.label !== "string" || !isOneLine(lnk.label, ONE_LINE_MAX_TITLE) || !isSafeUrl(lnk.url)) {
              return { valid: false, reason: "block(links): invalid link entry", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
            }
          }
          break
        }
        case "releases": {
          if (!Array.isArray(block.releases) || block.releases.length === 0 || block.releases.length > 12) {
            return { valid: false, reason: "block(releases): releases must have 1 to 12 entries", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
          }
          for (const rel of block.releases) {
            if (
              !isPlainObject(rel) ||
              typeof rel.name !== "string" ||
              !isOneLine(rel.name, ONE_LINE_MAX_TITLE) ||
              !isSafeUrl(rel.url) ||
              !isValidCalendarDate(rel.date)
            ) {
              return { valid: false, reason: "block(releases): invalid release entry", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
            }
          }
          break
        }
        case "markdown": {
          if (
            typeof block.path !== "string" ||
            block.path.length === 0 ||
            block.path.length > 1024 ||
            CONTROL_CHAR_PATTERN.test(block.path) ||
            ENCODED_TRAVERSAL_PATTERN.test(block.path) ||
            !SAFE_MD_PATH_PATTERN.test(block.path)
          ) {
            return { valid: false, reason: "block(markdown): invalid relative path", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
          }
          break
        }
        case "text": {
          if (typeof block.text !== "string" || block.text.length === 0 || block.text.length > MAX_CODE_OR_TEXT || hasHtml(block.text) || block.text.includes("\0")) {
            return { valid: false, reason: "block(text): invalid text", sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
          }
          break
        }
        default: {
          if (!ALLOWED_LIVE_BLOCK_TYPES.has(block.type)) {
            return { valid: false, reason: `block: unknown block type ${block.type.slice(0, 40)}`, sectionsCount: rawSections.length, blocksCount: totalBlocks, audiences: Array.from(audiences) }
          }
          break
        }
      }
    }
  }

  return {
    valid: true,
    reason: null,
    sectionsCount: rawSections.length,
    blocksCount: totalBlocks,
    audiences: Array.from(audiences)
  }
}
