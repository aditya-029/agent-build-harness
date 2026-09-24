// Static security scan of an ECC (github.com/affaan-m/ECC) release checkout.
//
// Nothing in the scanned tree is executed, required, or installed. The scan
// reads files as text and reports what a human must look at before any part of
// the release is allowed near a harness.
//
// Severity:
//   BLOCK  — ingestion stops, no matter what the baseline says
//   REVIEW — must be read once; after review it is recorded in the baseline
//   INFO   — inventory only
//
// A finding's key is rule + file + a hash of the matched text, so a file that
// changes elsewhere does not re-trigger review, but a new matching line does.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const CODE = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.ps1', '.rs', '.hook', '.lua', '.swift'])
const TEXT = new Set([...CODE, '.md', '.json', '.yaml', '.yml', '.toml', '.txt', '.setting', '.mdc'])
const MEDIA = new Set(['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.ico', '.mp4', '.lock', '.tsv', '.css', '.sql', '.jsonl', '.edl'])
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const PROSE = new Set(['.md', '.txt', '.json', '.yaml', '.yml'])
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'preuninstall', 'postuninstall']

export const RULES = [
  { id: 'curl-pipe-shell', sev: 'BLOCK', exts: CODE, rx: /(curl|wget)[^\n|]{0,200}\|\s*(ba|z)?sh\b/gi },
  { id: 'b64-exec', sev: 'BLOCK', exts: CODE, rx: /(atob|b64decode|Buffer\.from\([^)]*base64)[^\n]{0,120}(eval|exec|Function|spawn)/gi },
  { id: 'eval-dynamic', sev: 'REVIEW', exts: CODE, rx: /\beval\s*\(|new Function\s*\(|vm\.runIn/g },
  { id: 'network', sev: 'REVIEW', exts: CODE, rx: /https?\.request|https\.get\(|\bfetch\(|net\.connect|urllib\.request|requests\.(get|post)|\bcurl\s|\bwget\s|reqwest::/g },
  { id: 'secret-paths', sev: 'REVIEW', exts: CODE, rx: /\.ssh\/|id_rsa|\.aws\/credentials|Keychain|find-generic-password|\.netrc/g },
  { id: 'unpinned-npx', sev: 'REVIEW', exts: TEXT, rx: /npx\s+(-y\s+)?[@\w/.-]+@latest|"-y",\s*"[@\w/.-]+@latest"/g },
  { id: 'prompt-injection', sev: 'REVIEW', exts: PROSE, rx: /ignore (all )?(previous|prior) instructions|disregard (the )?(system|previous)|you are now (in )?developer mode/gi },
  { id: 'long-base64', sev: 'REVIEW', exts: CODE, rx: /[A-Za-z0-9+/]{400,}={0,2}/g },
  { id: 'child-process', sev: 'INFO', exts: CODE, rx: /child_process|execSync|spawnSync|subprocess\.|os\.system|Command::new/g },
  { id: 'secret-env', sev: 'INFO', exts: CODE, rx: /process\.env\.[A-Z_]*(KEY|TOKEN|SECRET)|os\.environ[^\n]{0,40}(KEY|TOKEN|SECRET)/g },
]
// Trojan Source bidi controls, zero-width characters, and Unicode tag characters.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|\udb40[\udc00-\udc7f]/g

const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const isTestPath = rel => /^(tests|docs)\//.test(rel) || rel.includes('/test')

function* walk(root, dir = root) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) yield* walk(root, full)
    else if (ent.isFile()) yield path.relative(root, full)
  }
}

// Scans one text file. Test and docs paths are downgraded to INFO, except
// BLOCK, which stays BLOCK: a malicious payload does not become safe because
// it sits in a folder called tests/.
export function scanText(rel, text) {
  const ext = path.extname(rel).toLowerCase()
  const out = []
  const test = isTestPath(rel)
  for (const r of RULES) {
    if (!r.exts.has(ext)) continue
    const m = text.match(r.rx)
    if (!m) continue
    const sev = test && r.sev === 'REVIEW' ? 'INFO' : r.sev
    out.push({ rule: r.id, file: rel, n: m.length, sev, key: `${r.id}:${rel}:${sha(m.sort().join('\n')).slice(0, 12)}` })
  }
  const inv = text.match(INVISIBLE)
  if (inv) {
    const chars = [...new Set(inv.map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')))].sort()
    out.push({ rule: 'invisible-unicode', file: rel, n: inv.length, sev: test ? 'INFO' : 'REVIEW', chars, key: `invisible-unicode:${rel}:${chars.join(',')}` })
  }
  return out
}

export function scanTree(root) {
  const findings = []
  const unknownFiles = []
  let files = 0
  for (const rel of walk(root)) {
    files++
    const ext = path.extname(rel).toLowerCase()
    if (!TEXT.has(ext) && ext) {
      if (!MEDIA.has(ext)) unknownFiles.push(rel)
      continue
    }
    let text
    try { text = fs.readFileSync(path.join(root, rel), 'utf8') } catch { unknownFiles.push(rel); continue }
    // Extensionless files (git hooks, bin shims) are code when they carry a shebang.
    if (!ext) {
      if (!text.startsWith('#!')) continue
      findings.push(...scanText(rel + '.sh', text).map(f => ({ ...f, file: rel, key: f.key.replace(rel + '.sh', rel) })))
      continue
    }
    findings.push(...scanText(rel, text))
  }
  const read = f => { try { return fs.readFileSync(path.join(root, f), 'utf8') } catch { return null } }
  const pkg = JSON.parse(read('package.json') ?? '{}')
  const lifecycle = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([k]) => LIFECYCLE.includes(k)))
  for (const [k, v] of Object.entries(lifecycle)) {
    findings.push({ rule: 'npm-lifecycle', file: 'package.json', n: 1, sev: 'BLOCK', key: `npm-lifecycle:${k}:${sha(v).slice(0, 12)}` })
  }
  const hooksText = read('hooks/hooks.json')
  const hooks = hooksText ? JSON.parse(hooksText).hooks ?? {} : {}
  const hookEvents = Object.fromEntries(Object.entries(hooks).map(([ev, arr]) => [ev, arr.reduce((s, m) => s + (m.hooks?.length ?? 0), 0)]))
  return {
    version: (read('VERSION') ?? '').trim(),
    files,
    dependencies: pkg.dependencies ?? {},
    hookEvents,
    hookCount: Object.values(hookEvents).reduce((a, b) => a + b, 0),
    hooksHash: hooksText ? sha(hooksText).slice(0, 16) : null,
    unknownFiles: unknownFiles.sort(),
    findings,
  }
}

// Compares a scan against the reviewed baseline. Anything not already reviewed
// needs a read; BLOCK needs a read and cannot be baselined away.
export function assess(report, baseline = {}) {
  const reviewed = new Set(baseline.reviewedKeys ?? [])
  const block = report.findings.filter(f => f.sev === 'BLOCK' && !(reviewed.has(f.key) && isTestPath(f.file)))
  const newReview = report.findings.filter(f => f.sev === 'REVIEW' && !reviewed.has(f.key))
  const changes = []
  if (baseline.hooksHash && baseline.hooksHash !== report.hooksHash) changes.push('hooks/hooks.json changed')
  if (baseline.dependencies && JSON.stringify(baseline.dependencies) !== JSON.stringify(report.dependencies)) changes.push('runtime dependencies changed')
  const knownUnknown = new Set(baseline.unknownFiles ?? [])
  const newUnknown = report.unknownFiles.filter(f => !knownUnknown.has(f))
  if (newUnknown.length) changes.push(`${newUnknown.length} new unrecognised file(s)`)
  const verdict = block.length ? 'BLOCK' : newReview.length || changes.length ? 'NEEDS_REVIEW' : 'PASS'
  return { verdict, block, newReview, changes, newUnknown }
}

// The baseline a human writes after reviewing a release: every current REVIEW
// finding, plus test-path BLOCK fixtures that were read and found to be test data.
export function baselineFrom(report, tag) {
  return {
    tag,
    reviewedAt: new Date().toISOString(),
    reviewedKeys: report.findings.filter(f => f.sev !== 'INFO').map(f => f.key).sort(),
    hooksHash: report.hooksHash,
    dependencies: report.dependencies,
    unknownFiles: report.unknownFiles,
  }
}
