// The public-mirror leak gate (D14, unit F3).
//
// Showcase projects live in the private monorepo and are published as their
// own public repositories with `git subtree split`. A split carries the
// folder's WHOLE history, so the gate scans every blob that would be pushed —
// not just the current tree. A secret deleted in the latest commit is still
// public the moment the history is.
//
// Two classes of finding:
//   secret    — credential-shaped strings (keys, tokens, private keys)
//   personal  — this machine's home path, phone numbers, and whatever the
//               operator lists in the private denylist (names of employers,
//               visa details, addresses — things no regex can know)
//
// Fixtures that are fake on purpose carry `leakgate:allow` on the same line.
// That is visible in review, which a path-level exemption would not be.

export const SECRET_PATTERNS = [
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{16,}/],
  ['openai key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['github token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['aws access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['google api key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['assigned secret', /\b(?:api[_-]?key|secret|password|passwd|token)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i],
]

export const PERSONAL_PATTERNS = [
  ['home path', /\/Users\/(?!runner\b|shared\b|Shared\b|you\b|me\b|name\b|username\b|<)[A-Za-z0-9._-]+\//],
  ['au phone', /(?:\+61[ -]?4|\b04)\d{2}[ -]?\d{3}[ -]?\d{3}\b/],
]

// Files whose names alone are a finding, whatever they contain.
export const FORBIDDEN_NAMES = [/(^|\/)\.env(\.[^/]*)?$/, /\.(pem|key|p12|pfx)$/, /(^|\/)id_(rsa|ed25519|ecdsa)$/]
export const ALLOW_MARK = 'leakgate:allow'

/** One denylist term per line; blank lines and `#` comments ignored. Case-insensitive. */
export function parseDenylist(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
}

const isExample = p => /\.(example|sample|template)$/.test(p) || /(^|\/)\.env\.example$/.test(p)

/**
 * Scan one blob. Returns findings `{ path, line, kind, rule, excerpt }`.
 * Excerpts are masked — the gate's own report must not re-leak the secret.
 */
export function scanBlob(filePath, text, { denylist = [] } = {}) {
  const findings = []
  if (FORBIDDEN_NAMES.some(re => re.test(filePath)) && !isExample(filePath)) {
    findings.push({ path: filePath, line: 0, kind: 'secret', rule: 'forbidden file', excerpt: filePath })
  }
  if (typeof text !== 'string' || !text) return findings
  const terms = denylist.map(t => t.toLowerCase())
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (ln.includes(ALLOW_MARK)) continue
    for (const [rule, re] of SECRET_PATTERNS) {
      const m = ln.match(re)
      if (m) findings.push({ path: filePath, line: i + 1, kind: 'secret', rule, excerpt: mask(m[0]) })
    }
    for (const [rule, re] of PERSONAL_PATTERNS) {
      const m = ln.match(re)
      if (m) findings.push({ path: filePath, line: i + 1, kind: 'personal', rule, excerpt: mask(m[0]) })
    }
    const low = ln.toLowerCase()
    for (const t of terms) {
      if (low.includes(t)) findings.push({ path: filePath, line: i + 1, kind: 'personal', rule: 'denylist', excerpt: mask(t) })
    }
  }
  return findings
}

export function mask(s) {
  const v = String(s)
  return v.length <= 8 ? `${v.slice(0, 2)}…` : `${v.slice(0, 6)}…(${v.length})`
}

/**
 * Scan every blob a push would publish. `blobs` is [{ path, text }] with
 * binary content already skipped by the caller (text === null).
 */
export function mirrorScan(blobs, opts = {}) {
  const findings = []
  const seen = new Set()
  for (const b of blobs) {
    for (const f of scanBlob(b.path, b.text, opts)) {
      const key = `${f.path}:${f.line}:${f.rule}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push({ ...f, commit: b.commit ?? null })
    }
  }
  return { ok: findings.length === 0, findings }
}
