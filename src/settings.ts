// The plugin's copy of the ConPort project settings rules: `.conport.json` in the project root,
// committed and shared by the team, and `.conport.local.json` beside it, ignored by git, for
// personal overrides. Pure functions over the texts of the two files, the environment and what
// git says about the personal file; the worker reads the files and asks git. The copy passes the
// `resolve` cases of the conport plugin's shared fixture (`scripts/test/fixtures/
// project-config-cases.json`), as every reader of these files does. It has no search for the
// root: the plugin's root is the main working tree Orca names.

const SETTINGS_FILE = '.conport.json'
const LOCAL_SETTINGS_FILE = '.conport.local.json'
const API_KEY_NAMES = new Set(['api_key', 'apikey', 'conport_api_key'])
const API_KEY_PREFIX = 'cport_'

const TYPE_WORDS = {
  project_name: 'a non-empty string',
  plugins: 'an object',
  'plugins.superpowers': 'true or false',
  'plugins.codegraph': 'true or false',
  arch: 'an object',
  'arch.ignore': 'a list of path patterns or {"path", "reason"} objects',
  'arch.git': 'true or false',
  units: 'a list'
} as const

type SettingsKey = keyof typeof TYPE_WORDS

/** A settings file as read: its text, null when there is none, its error code when it cannot be read. */
export type SettingsText = string | { error: string } | null

export interface SettingsInput {
  /** `.conport.json`. */
  shared: SettingsText
  /** `.conport.local.json`. */
  local: SettingsText
  /** Whether git ignores the personal file and does not track it; null when git cannot tell. */
  localIgnored: boolean | null
  /** The environment the project name may come from (`CONPORT_PROJECT_NAME`). */
  env: Record<string, string | undefined>
  /** A project named by the caller, which no file overrides. */
  explicit: string | null
  /** The text of `~/.config/conport/.env`, null when there is none. */
  userEnv: string | null
}

/** An element of `arch.ignore`: a path pattern, or one with the reason it is ignored. */
export type IgnoreEntry = string | { path: string; reason: string }

export interface Settings {
  plugins: { superpowers?: boolean; codegraph?: boolean }
  arch: { ignore?: IgnoreEntry[]; git?: boolean }
  units?: unknown[]
}

export interface SettingsResult {
  project: string | null
  /** Where the project came from: a file, the variable, the caller; null with no project. */
  source: string | null
  settings: Settings
  /** What the person should know about the settings, in the order every reader says it. */
  lines: string[]
}

// ---------------------------------------------------------------------------
// JSON

const isWhitespace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39
const isHex = (c: number): boolean => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)

/**
 * Offset of the first character at which `text` stops being the start of a valid JSON text
 * (RFC 8259), the length of the text when it ends too early, or -1 when the whole text is valid.
 * Iterative, so no input overflows the stack.
 */
function jsonErrorOffset(text: string): number {
  const n = text.length
  let i = 0
  const stack: Array<'{' | '['> = []
  const skip = (): void => {
    while (i < n && isWhitespace(text.charCodeAt(i))) i++
  }
  // One string from its opening quote.
  const string = (): number => {
    i++
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c === 0x22) {
        i++
        return -1
      }
      if (c < 0x20) return i
      if (c === 0x5c) {
        i++
        if (i >= n) return n
        const e = text[i] ?? ''
        if (e === 'u') {
          for (let k = 1; k <= 4; k++) {
            if (i + k >= n) return n
            if (!isHex(text.charCodeAt(i + k))) return i + k
          }
          i += 5
          continue
        }
        if ('"\\/bfnrt'.includes(e)) {
          i++
          continue
        }
        return i
      }
      i++
    }
    return n
  }
  const number = (): number => {
    if (text[i] === '-') i++
    if (i >= n) return n
    if (text[i] === '0') {
      i++
    } else if (isDigit(text.charCodeAt(i))) {
      while (i < n && isDigit(text.charCodeAt(i))) i++
    } else {
      return i
    }
    if (text[i] === '.') {
      i++
      if (i >= n) return n
      if (!isDigit(text.charCodeAt(i))) return i
      while (i < n && isDigit(text.charCodeAt(i))) i++
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++
      if (text[i] === '+' || text[i] === '-') i++
      if (i >= n) return n
      if (!isDigit(text.charCodeAt(i))) return i
      while (i < n && isDigit(text.charCodeAt(i))) i++
    }
    // A digit right after a leading zero ends the number: `01` fails at `1` where the caller
    // looks for what may follow a value.
    return -1
  }
  const literal = (word: string): number => {
    for (let k = 0; k < word.length; k++) {
      if (i + k >= n) return n
      if (text[i + k] !== word[k]) return i + k
    }
    i += word.length
    return -1
  }
  // The key and the colon of an object member, at the key.
  const memberKey = (): number => {
    skip()
    if (i >= n) return n
    if (text[i] !== '"') return i
    const bad = string()
    if (bad >= 0) return bad
    skip()
    if (i >= n) return n
    if (text[i] !== ':') return i
    i++
    return -1
  }
  // One value. An opened container is pushed and the scan goes on to its first value; the ends
  // of containers are handled by the loop below.
  const value = (): number => {
    for (;;) {
      skip()
      if (i >= n) return n
      const ch = text[i]
      if (ch === '{' || ch === '[') {
        const close = ch === '{' ? '}' : ']'
        i++
        skip()
        if (i >= n) return n
        if (text[i] === close) {
          i++
          return -1
        }
        stack.push(ch)
        if (ch === '{') {
          const bad = memberKey()
          if (bad >= 0) return bad
        }
        continue
      }
      if (ch === '"') return string()
      if (ch === '-' || isDigit(text.charCodeAt(i))) return number()
      if (ch === 't') return literal('true')
      if (ch === 'f') return literal('false')
      if (ch === 'n') return literal('null')
      return i
    }
  }
  const member = (): number => {
    const bad = memberKey()
    return bad >= 0 ? bad : value()
  }

  let bad = value()
  while (bad < 0) {
    skip()
    if (stack.length === 0) return i < n ? i : -1
    if (i >= n) return n
    const top = stack[stack.length - 1]
    const ch = text[i]
    if (ch === ',') {
      i++
      bad = top === '{' ? member() : value()
    } else if ((top === '{' && ch === '}') || (top === '[' && ch === ']')) {
      i++
      stack.pop()
    } else {
      return i
    }
  }
  return bad
}

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/**
 * Where `text` stops being valid JSON — the line counted by `\n`, the column as 1 plus the UTF-16
 * code units after the last `\n` — or null when it is valid. A leading byte order mark is dropped
 * first and does not count.
 */
export function jsonErrorPosition(text: string): { line: number; column: number } | null {
  const t = stripBom(String(text))
  const offset = jsonErrorOffset(t)
  if (offset < 0) return null
  const before = t.slice(0, offset)
  let line = 1
  for (let k = 0; k < before.length; k++) if (before.charCodeAt(k) === 0x0a) line++
  return { line, column: offset - before.lastIndexOf('\n') }
}

// ---------------------------------------------------------------------------
// The rules

type JsonObject = Record<string, unknown>

const isObject = (v: unknown): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v)

const has = (obj: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key)

/** Sets an own key, `__proto__` included, as JSON.parse does. */
function setOwn(obj: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

const isApiKeyValue = (v: unknown): boolean => typeof v === 'string' && v.trimStart().startsWith(API_KEY_PREFIX)

/**
 * `value` without API keys: a key named like one is dropped with its value, a string starting
 * with `cport_` is dropped wherever it is, array elements included. `found.any` is set when
 * something was dropped.
 */
function scrub(value: unknown, found: { any: boolean }): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      if (isApiKeyValue(item)) {
        found.any = true
        continue
      }
      out.push(scrub(item, found))
    }
    return out
  }
  if (isObject(value)) {
    const out: JsonObject = {}
    for (const [k, v] of Object.entries(value)) {
      if (API_KEY_NAMES.has(k.toLowerCase()) || isApiKeyValue(v)) {
        found.any = true
        continue
      }
      setOwn(out, k, scrub(v, found))
    }
    return out
  }
  return value
}

/**
 * A path pattern of the arch dialect: POSIX, from the project root, made of segments with `*`,
 * `**` and `?`, a trailing `/` for a folder. Anything a matcher of that dialect would silently
 * never match is refused: a blank string, a `\`, an empty segment, a `.` or `..` segment.
 */
function isPattern(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim() || p.includes('\\')) return false
  const body = p.endsWith('/') ? p.slice(0, -1) : p
  return body.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

/** An element of arch.ignore: a pattern, or an object of exactly a pattern `path` and a string `reason`. */
function isIgnoreEntry(e: unknown): boolean {
  if (typeof e === 'string') return isPattern(e)
  if (!isObject(e)) return false
  return Object.keys(e).length === 2 && isPattern(e.path) && typeof e.reason === 'string'
}

interface FileVerdict {
  readError: string | null
  lines: string[]
  values: { plugins?: Settings['plugins']; arch?: Settings['arch']; units?: unknown[] }
  /** The file is there but cannot name a project, so no project is named at all. */
  blocks: boolean
  name: string | null
}

/** One file's text read by the rules. */
function readFile(file: string, input: SettingsText | undefined, isLocal: boolean): FileVerdict {
  const out: FileVerdict = { readError: null, lines: [], values: {}, blocks: false, name: null }
  if (input === null || input === undefined) return out
  if (typeof input === 'object') {
    out.readError = `${file} cannot be read (${input.error}): fix it`
    out.blocks = true
    return out
  }
  // The byte order mark is dropped once: jsonErrorPosition drops it for the check, JSON.parse
  // gets the same text without it.
  const pos = jsonErrorPosition(input)
  if (pos) {
    out.lines.push(`${file} is not valid JSON (line ${pos.line}, column ${pos.column}): fix it`)
    out.blocks = true
    return out
  }
  const parsed: unknown = JSON.parse(stripBom(input))
  if (!isObject(parsed)) {
    out.lines.push(`${file} must hold a JSON object — fix it`)
    out.blocks = true
    return out
  }
  const found = { any: false }
  const nameIsKey = has(parsed, 'project_name') && isApiKeyValue(parsed.project_name)
  const data = scrub(parsed, found) as JsonObject
  if (found.any) {
    out.lines.push(
      `${file} holds an API key: revoke it at https://me.conport.app/dashboard/connect, create a new one and keep it in ~/.config/conport/.env`
    )
  }
  if (nameIsKey) out.blocks = true
  const wrong = (key: SettingsKey): void => {
    out.lines.push(`${file}: ${key} must be ${TYPE_WORDS[key]} — fix it`)
  }

  if (has(data, 'project_name')) {
    const v = data.project_name
    if (typeof v === 'string' && v.trim()) {
      out.name = v.trim()
    } else {
      wrong('project_name')
      out.blocks = true
    }
  }
  if (has(data, 'plugins')) {
    const given = data.plugins
    if (!isObject(given)) {
      wrong('plugins')
    } else {
      const plugins: Settings['plugins'] = {}
      for (const k of ['superpowers', 'codegraph'] as const) {
        if (!has(given, k)) continue
        const v = given[k]
        if (typeof v === 'boolean') plugins[k] = v
        else wrong(`plugins.${k}`)
      }
      out.values.plugins = plugins
    }
  }
  if (!isLocal) {
    if (has(data, 'arch')) {
      const given = data.arch
      if (!isObject(given)) {
        wrong('arch')
      } else {
        const arch: Settings['arch'] = {}
        if (has(given, 'ignore')) {
          const ig = given.ignore
          if (Array.isArray(ig) && ig.every(isIgnoreEntry)) {
            arch.ignore = ig.map((e: unknown) => {
              if (typeof e === 'string') return e
              const entry = e as { path: string; reason: string }
              return { path: entry.path, reason: entry.reason }
            })
          } else {
            wrong('arch.ignore')
          }
        }
        if (has(given, 'git')) {
          if (typeof given.git === 'boolean') arch.git = given.git
          else wrong('arch.git')
        }
        out.values.arch = arch
      }
    }
    if (has(data, 'units')) {
      if (Array.isArray(data.units)) out.values.units = data.units
      else wrong('units')
    }
  } else {
    for (const k of ['arch', 'units']) {
      if (has(data, k)) out.lines.push(`${k} is read from .conport.json only`)
    }
  }
  return out
}

/** Whether the text of ~/.config/conport/.env assigns CONPORT_PROJECT_NAME. */
function userEnvNamesProject(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false
  return text.split(/\r?\n/).some((l) => /^\s*(export\s+)?CONPORT_PROJECT_NAME\s*=/.test(l))
}

function envName(env: SettingsInput['env'] | undefined): string | null {
  const v = env?.CONPORT_PROJECT_NAME
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * The rules, and whether a settings file is there but broken (unreadable, not JSON, not an
 * object, a bad project_name): such a file names no project, and nothing stands in for it.
 */
export function readSettings(input: SettingsInput): SettingsResult & { blocked: boolean } {
  const shared = readFile(SETTINGS_FILE, input.shared, false)
  const local = readFile(LOCAL_SETTINGS_FILE, input.local, true)
  const lines: string[] = []
  for (const f of [shared, local]) if (f.readError) lines.push(f.readError)
  lines.push(...shared.lines, ...local.lines)
  if (input.local !== null && input.local !== undefined && input.localIgnored === false) {
    lines.push(`${LOCAL_SETTINGS_FILE} is not ignored by git: add it to .gitignore`)
  }

  const settings: Settings = {
    plugins: { ...(shared.values.plugins ?? {}), ...(local.values.plugins ?? {}) },
    arch: { ...(shared.values.arch ?? {}) }
  }
  if (shared.values.units) settings.units = shared.values.units

  let project: string | null = null
  let source: string | null = null
  const blocked = shared.blocks || local.blocks
  const explicit = typeof input.explicit === 'string' && input.explicit.trim() ? input.explicit.trim() : null
  const variable = envName(input.env)
  if (explicit) {
    project = explicit
    source = 'explicit'
  } else {
    if (local.name !== null) {
      project = local.name
      source = LOCAL_SETTINGS_FILE
      if (shared.name !== null && shared.name !== local.name) {
        lines.push(`project_name from ${LOCAL_SETTINGS_FILE} (${local.name}) overrides ${SETTINGS_FILE} (${shared.name})`)
      }
    } else if (shared.name !== null) {
      project = shared.name
      source = SETTINGS_FILE
    }
    if (blocked) {
      // A broken file, either one, names no project: neither the other file nor the variable
      // stands in for what it may have named.
      project = null
      source = null
    } else if (project !== null) {
      if (variable !== null && variable !== project) {
        lines.push(`CONPORT_PROJECT_NAME is ignored: ${source} names ${project} — remove the variable`)
      }
    } else if (variable !== null) {
      project = variable
      source = 'CONPORT_PROJECT_NAME'
    }
  }
  if (userEnvNamesProject(input.userEnv)) {
    lines.push('CONPORT_PROJECT_NAME in ~/.config/conport/.env is not read: it would apply to every repository — remove it')
  }
  return { project, source, settings, lines, blocked }
}

/**
 * The settings and the project from the two files, the environment and an explicit argument.
 * The project comes from the explicit argument, then from project_name of the merged files (the
 * personal file over the shared one), then from CONPORT_PROJECT_NAME when no file names one. A
 * file that is there but broken names no project, and neither the other file nor the variable
 * stands in for it. ~/.config/conport/.env never names it.
 */
export function resolveSettings(input: SettingsInput): SettingsResult {
  const { blocked: _blocked, ...result } = readSettings(input)
  return result
}
