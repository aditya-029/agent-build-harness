#!/usr/bin/env node
// Routine ingestion of stable ECC releases (github.com/affaan-m/ECC).
//
//   node src/ecc-ingest.mjs status            where things stand; no network
//   node src/ecc-ingest.mjs check             ask GitHub for the latest stable release; no writes
//   node src/ecc-ingest.mjs ingest            quarantine + scan the latest release if it is new
//   node src/ecc-ingest.mjs approve <tag> [note]  human gate: baseline the reviewed findings, promote
//   node src/ecc-ingest.mjs install-schedule  weekly launchd job (Sunday 10:00) that runs `ingest`
//
// Cost: one unauthenticated GitHub API call per run and zero LLM tokens. An LLM
// only gets involved when a release lands in quarantine as NEEDS_REVIEW, and
// only when the operator opens a session to review it.
//
// Nothing from the release is executed, installed, or activated here. A
// promoted release is a read-only reference under vendor/ecc/current; moving any
// of it into a live harness is a separate, deliberate merge unit.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanTree, assess, baselineFrom } from './ecc-scan.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = 'affaan-m/ECC'
const VENDOR = path.join(REPO, 'vendor', 'ecc')
const QUARANTINE = path.join(VENDOR, 'quarantine')
const RELEASES = path.join(VENDOR, 'releases')
const STATE = path.join(VENDOR, 'state.json')
const DOCS = path.join(REPO, 'docs', 'ecc')
const BASELINE = path.join(DOCS, 'baseline.json')
const LABEL = 'com.harness.ecc-ingest'
const KEEP_RELEASES = 2

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1) + '\n') }
const log = msg => console.log(`[ecc-ingest ${new Date().toISOString()}] ${msg}`)
const TAG_RX = /^v\d+\.\d+\.\d+$/

// Stable = GitHub's /releases/latest, which excludes drafts and prereleases.
// The tag pattern is a second filter: a vX.Y.Z-rc tag is never stable.
async function latestStable() {
  const res = await fetch(`https://api.github.com/repos/${UPSTREAM}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-build-harness-ecc-ingest' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const r = await res.json()
  if (r.draft || r.prerelease || !TAG_RX.test(r.tag_name)) throw new Error(`latest release ${r.tag_name} is not a stable vX.Y.Z tag`)
  return { tag: r.tag_name, publishedAt: r.published_at, url: r.html_url }
}

// Hooks disabled, no submodules, no file:// transport, no credential prompt.
// The .git directory is removed after the commit is recorded so nothing in the
// quarantined tree can be mistaken for a live repository.
function cloneTag(tag, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'advice.detachedHead=false',
    'clone', '--quiet', '--depth', '1', '--branch', tag, '--no-recurse-submodules',
    `https://github.com/${UPSTREAM}.git`, dest,
  ], { env: { PATH: process.env.PATH, HOME: os.homedir(), GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'ignore', 'pipe'] })
  const commit = execFileSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true })
  return commit
}

function manifest(root) {
  const out = {}
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) out[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16)
    }
  }
  walk(root)
  return out
}

// What changed between two releases, grouped by the part of ECC it belongs to.
// This is the input to a merge unit: it says which skills/agents/hooks to look at.
export function diffManifests(prev = {}, next = {}) {
  const group = f => (f.startsWith('.') ? f.split('/')[0] : f.includes('/') ? f.split('/')[0] : '(root)')
  const byArea = {}
  const add = (kind, f) => { ((byArea[group(f)] ??= { added: [], removed: [], changed: [] })[kind]).push(f) }
  for (const f of Object.keys(next)) if (!(f in prev)) add('added', f); else if (prev[f] !== next[f]) add('changed', f)
  for (const f of Object.keys(prev)) if (!(f in next)) add('removed', f)
  return byArea
}

function renderReport({ tag, commit, publishedAt, previous, report, result, diff }) {
  const L = []
  const list = (items, cap = 25) => items.slice(0, cap).map(x => `- ${x}`).concat(items.length > cap ? [`- … ${items.length - cap} more`] : [])
  L.push(`# ECC ${tag} — ingestion report`, '')
  L.push(`**Verdict: ${result.verdict}** · commit \`${commit.slice(0, 12)}\` · published ${publishedAt?.slice(0, 10) ?? '?'} · previous ${previous ?? 'none'}`, '')
  L.push(`Files ${report.files} · hooks ${report.hookCount} (${Object.entries(report.hookEvents).map(([k, v]) => `${k} ${v}`).join(', ')}) · runtime deps ${Object.entries(report.dependencies).map(([k, v]) => `${k}@${v}`).join(', ') || 'none'}`, '')
  if (result.block.length) L.push('## BLOCK', ...list(result.block.map(f => `\`${f.rule}\` ${f.file} ×${f.n}`)), '')
  if (result.changes.length) L.push('## Structural changes', ...list(result.changes), '')
  if (result.newUnknown.length) L.push('## New unrecognised files', ...list(result.newUnknown), '')
  if (result.newReview.length) L.push('## New findings to review', ...list(result.newReview.map(f => `\`${f.rule}\` ${f.file} ×${f.n}${f.chars ? ' ' + f.chars.join(' ') : ''}`), 60), '')
  L.push('## What changed since the previous release', '')
  const areas = previous ? Object.entries(diff).sort((a, b) => a[0].localeCompare(b[0])) : []
  if (!previous) L.push('First ingestion; no previous release to compare.', '')
  else if (!areas.length) L.push('Nothing.', '')
  for (const [area, d] of areas) {
    L.push(`### ${area} (+${d.added.length} ~${d.changed.length} −${d.removed.length})`)
    if (['skills', 'agents', 'commands', 'hooks', 'rules', '(root)'].includes(area)) {
      L.push(...list(d.added.map(f => `added ${f}`), 15), ...list(d.removed.map(f => `removed ${f}`), 15), ...list(d.changed.map(f => `changed ${f}`), 15))
    }
    L.push('')
  }
  L.push('## Next step', '')
  L.push(result.verdict === 'PASS'
    ? 'Promoted automatically to `vendor/ecc/current`. Merge candidates: the added/changed skills, agents and hooks above.'
    : `Held in \`vendor/ecc/quarantine/${tag}\`. Read every item above, then run \`node src/ecc-ingest.mjs approve ${tag}\`. A non-test BLOCK cannot be approved.`)
  return L.join('\n') + '\n'
}

function promote(tag, state) {
  fs.mkdirSync(RELEASES, { recursive: true })
  const dest = path.join(RELEASES, tag)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.renameSync(path.join(QUARANTINE, tag), dest)
  const link = path.join(VENDOR, 'current')
  fs.rmSync(link, { force: true })
  fs.symlinkSync(path.join('releases', tag), link)
  const kept = fs.readdirSync(RELEASES).filter(t => TAG_RX.test(t))
    .sort((a, b) => a.slice(1).split('.').map(Number).reduce((c, n, i) => c || n - b.slice(1).split('.').map(Number)[i], 0))
  for (const old of kept.slice(0, Math.max(0, kept.length - KEEP_RELEASES))) fs.rmSync(path.join(RELEASES, old), { recursive: true, force: true })
  state.current = tag
  delete state.pending
}

function notify(text) {
  if (process.platform !== 'darwin') return
  try { execFileSync('osascript', ['-e', `display notification ${JSON.stringify(text)} with title "ECC ingest"`]) } catch {}
}

async function ingest(state) {
  const latest = await latestStable()
  state.lastChecked = new Date().toISOString()
  if (latest.tag === state.current) { log(`up to date at ${latest.tag}`); return 0 }
  if (state.pending?.tag === latest.tag) { log(`${latest.tag} already in quarantine (${state.pending.verdict}); waiting for approve`); return 0 }

  const qdir = path.join(QUARANTINE, latest.tag)
  log(`new stable release ${latest.tag}; cloning into quarantine`)
  const commit = cloneTag(latest.tag, qdir)
  const report = scanTree(qdir)
  const result = assess(report, readJson(BASELINE, {}))
  const man = manifest(qdir)
  const prevMan = state.current ? readJson(path.join(VENDOR, `manifest-${state.current}.json`), {}) : {}
  const diff = diffManifests(prevMan, man)
  writeJson(path.join(VENDOR, `manifest-${latest.tag}.json`), man)
  writeJson(path.join(VENDOR, `scan-${latest.tag}.json`), { commit, ...report })
  fs.mkdirSync(path.join(DOCS, 'releases'), { recursive: true })
  fs.writeFileSync(path.join(DOCS, 'releases', `${latest.tag}.md`),
    renderReport({ tag: latest.tag, commit, publishedAt: latest.publishedAt, previous: state.current, report, result, diff }))

  if (result.verdict === 'PASS') {
    promote(latest.tag, state)
    log(`${latest.tag} PASS; promoted`)
    notify(`ECC ${latest.tag} validated and promoted`)
  } else {
    state.pending = { tag: latest.tag, verdict: result.verdict, commit }
    log(`${latest.tag} ${result.verdict}: ${result.block.length} block, ${result.newReview.length} new review, ${result.changes.join('; ') || 'no structural change'}`)
    notify(`ECC ${latest.tag} needs review (${result.verdict}) — see docs/ecc/releases/${latest.tag}.md`)
  }
  return 0
}

function approve(tag, state, note) {
  if (state.pending?.tag !== tag) throw new Error(`${tag} is not the pending release (pending: ${state.pending?.tag ?? 'none'})`)
  const scan = readJson(path.join(VENDOR, `scan-${tag}.json`), null)
  if (!scan) throw new Error(`no scan recorded for ${tag}`)
  const nonTestBlock = assess(scan, { reviewedKeys: scan.findings.map(f => f.key) }).block
  if (nonTestBlock.length) throw new Error(`${tag} has BLOCK findings outside tests/docs; it cannot be approved:\n${nonTestBlock.map(f => `  ${f.rule} ${f.file}`).join('\n')}`)
  writeJson(BASELINE, baselineFrom(scan, tag))
  fs.appendFileSync(path.join(DOCS, 'releases', `${tag}.md`),
    `\n## Approved ${new Date().toISOString().slice(0, 10)}\n\n${note || 'Every finding above was read.'}\n`)
  promote(tag, state)
  log(`${tag} approved; baseline updated and release promoted`)
  return 0
}

function installSchedule() {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
  const logFile = path.join(VENDOR, 'ingest.log')
  fs.mkdirSync(VENDOR, { recursive: true })
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>${LABEL}</string>
 <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(fileURLToPath(import.meta.url))}</string><string>ingest</string></array>
 <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
 <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
 <key>StandardOutPath</key><string>${esc(logFile)}</string>
 <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict></plist>
`)
  try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { stdio: 'ignore' }) } catch {}
  execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist])
  log(`installed ${plist}; runs Sundays 10:00, log ${logFile}`)
  return 0
}

async function main([cmd, arg, ...rest]) {
  const state = readJson(STATE, {})
  let code
  switch (cmd) {
    case 'status':
      console.log(JSON.stringify({ current: state.current ?? null, pending: state.pending ?? null, lastChecked: state.lastChecked ?? null }, null, 1))
      return 0
    case 'check': {
      const l = await latestStable()
      console.log(`latest stable ${l.tag} (${l.publishedAt.slice(0, 10)}); current ${state.current ?? 'none'}${l.tag === state.current ? ' — up to date' : ' — run ingest'}`)
      return 0
    }
    case 'ingest': code = await ingest(state); break
    case 'approve': code = approve(arg, state, rest.join(' ')); break
    case 'install-schedule': return installSchedule()
    default:
      console.error('usage: ecc-ingest.mjs status | check | ingest | approve <tag> | install-schedule')
      return 2
  }
  writeJson(STATE, state)
  return code
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(c => process.exit(c), e => { log(`error: ${e.message}`); process.exit(1) })
}
