#!/usr/bin/env node
// Harness v2 acceptance suite — units F3–F8 of docs/UNIT-QUEUE.md.
//
// Same rule as harness.test.mjs: decision modules are imported and driven
// directly; the CLI is driven for real inside a throwaway git repository with
// a throwaway HOME, and the provider CLIs are fakes on a private PATH. Nothing
// here can reach a real session, a real account window, or a real remote.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateQueue, readyUnits, effectiveStatus, blockedReason, unitBrief } from '../src/units.mjs'
import { decideNext, recordOutcome } from '../src/runner.mjs'
import { createNotifier, tierOf, claudePushArgs, loadChannels } from '../src/notify.mjs'
import { handleMessage, TOOLS } from '../src/mcp.mjs'
import { scanBlob, mirrorScan, parseDenylist, mask } from '../src/mirror.mjs'
import { validateBrief } from '../src/brief.mjs'
import { normalizeProviderEvent, codexWindowReading, headlessInvocation, codexOperatorServers } from '../src/providers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const H = path.resolve(HERE, '../src/harness.mjs')

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const now = () => Math.floor(Date.now() / 1000)
// Built at runtime so this file never contains a secret-shaped literal — the
// harness's own mirror is scanned by the same gate.
const FAKE_SECRET = ['sk', 'ant', 'api03'].join('-') + '-' + 'Q'.repeat(28)

const unit = (id, extra = {}) => ({ id, title: `unit ${id}`, owner: 'agent', acceptance: { command: `test -f built-${id}.txt` }, ...extra })

console.log('\n── F4 unit queue format')
{
  const bad = validateQueue({ units: [{ id: 'X', title: 'no command', owner: 'agent', acceptance: 'tests pass eventually'.replace(/.*/, '') }] })
  ok('a unit with no acceptance command is refused', !bad.ok && bad.problems.some(p => /REFUSED/.test(p)), bad.problems.join('; '))
  const prose = validateQueue({ units: [{ id: 'X', title: 't', owner: 'agent' }] })
  ok('a missing acceptance block is refused too', !prose.ok && /REFUSED/.test(prose.problems.join()))
  ok('owner must be adi or agent', !validateQueue({ units: [unit('A', { owner: 'bot' })] }).ok)
  ok('unknown dependency is named', /unknown unit "Z"/.test(validateQueue({ units: [unit('A', { depends: ['Z'] })] }).problems.join()))
  const cyc = validateQueue({ units: [unit('A', { depends: ['B'] }), unit('B', { depends: ['A'] })] })
  ok('dependency cycles are refused', /cycle/.test(cyc.problems.join()), cyc.problems.join())
  ok('duplicate ids are refused', /duplicate/.test(validateQueue({ units: [unit('A'), unit('A')] }).problems.join()))

  const q = validateQueue({ units: [
    unit('F1', { status: 'done' }), unit('E', { owner: 'adi', acceptance: 'test -f evals.json' }),
    unit('A', { depends: ['F1'] }), unit('B', { depends: ['E'] }), unit('M', { approval: 'money' }),
  ] })
  ok('a valid queue validates', q.ok, q.problems.join('; '))
  const ready = readyUnits(q.units, {}).map(u => u.id)
  ok('agent units with done deps are ready', ready.includes('A'))
  ok('adi units are never started by the runner', !ready.includes('E') && effectiveStatus(q.units[1]) === 'adi')
  ok('an agent unit waiting on an adi unit is not ready', !ready.includes('B'))
  ok('...and says who it waits on', /waiting on Adi: E/.test(blockedReason(q.units[3], q.units, {})))
  ok('an approval-gated unit waits for its release', !ready.includes('M'))
  ok('...and runs once released', readyUnits(q.units, { units: { M: { approved: true } } }).some(u => u.id === 'M'))
  const brief = unitBrief(q.units[2], { attempt: 2, lastFailure: 'boom' })
  ok('the unit brief passes the harness brief gate', validateBrief(brief).ok)
  ok('the brief carries the acceptance command and the last failure', /test -f built-A.txt/.test(brief) && /boom/.test(brief))
}

console.log('\n── F5 runner decisions')
{
  const q = validateQueue({ units: [unit('U1'), unit('U2', { depends: ['U1'] })] }).units
  const both = { claude: { installed: true, ok: true }, codex: { installed: true, ok: true, available: false } }
  const t = now()
  let d = decideNext({ units: q, providers: both, now: t })
  ok('first ready unit runs on claude', d.action === 'run' && d.unit.id === 'U1' && d.provider === 'claude')
  const after = recordOutcome({}, { unit: q[0], provider: 'claude', passed: true, now: t })
  d = decideNext({ units: q, runtime: after, providers: both, now: t })
  ok('a finished unit releases the next one immediately', d.action === 'run' && d.unit.id === 'U2')
  const capped = { claude: { installed: true, ok: false, resumeAt: t + 900 }, codex: { installed: true, ok: true, available: false } }
  d = decideNext({ units: q, providers: capped, now: t })
  ok('a capped claude hands the unit to codex', d.action === 'run' && d.provider === 'codex')
  ok('...and says codex is unmetered rather than free', d.metered === false)
  const allCapped = { claude: { installed: true, ok: false, resumeAt: t + 900 }, codex: { installed: true, ok: false, resumeAt: t + 300 } }
  d = decideNext({ units: q, providers: allCapped, now: t })
  ok('both capped parks until the EARLIEST reset', d.action === 'park' && d.until === t + 300)
  ok('attached holds the queue', decideNext({ units: q, providers: both, control: { attached: true }, now: t }).action === 'hold')
  ok('an attach request holds the queue', decideNext({ units: q, providers: both, control: { attachRequested: true }, now: t }).action === 'hold')
  ok('paused holds', decideNext({ units: q, providers: both, control: { paused: true }, now: t }).action === 'hold')
  const lim = recordOutcome({}, { unit: q[0], provider: 'codex', passed: false, limited: true, now: t })
  ok('a window-limited attempt is not counted', lim.units.U1.attempts === 0 && lim.current.provider === 'codex')
  d = decideNext({ units: q, runtime: lim, providers: both, now: t })
  ok('an interrupted unit resumes on its own provider and session', d.provider === 'codex' && d.resume === true)
  let r = {}
  for (let i = 0; i < 3; i++) r = recordOutcome(r, { unit: q[0], provider: 'claude', passed: false, now: t })
  ok('three red acceptances mark the unit failed', r.units.U1.status === 'failed')
  d = decideNext({ units: q, runtime: r, providers: both, now: t })
  ok('a failed unit stops its dependants and says so', d.action === 'idle' && /U2/.test(d.reason), d.reason)
}

console.log('\n── F8 notification tiers')
{
  ok('approval is immediate', tierOf('approval') === 'immediate')
  ok('failure is immediate', tierOf('failure') === 'immediate')
  ok('done is batched', tierOf('done') === 'batch')
  ok('progress is log only', tierOf('progress') === 'log')
  let clock = 1000
  const sent = []
  const n = createNotifier({ send: m => sent.push(m), now: () => clock, quietSec: 60, maxWaitSec: 300 })
  n.event({ kind: 'approval', title: 'a001', body: 'spend $5' })
  ok('an approval pushes at once', sent.length === 1 && sent[0].tier === 'immediate')
  n.event({ kind: 'progress', title: 'turn 3' })
  ok('progress never pushes', sent.length === 1)
  n.event({ kind: 'done', title: 'U1 done' }); clock += 10
  n.event({ kind: 'done', title: 'U2 done' }); clock += 10
  n.event({ kind: 'done', title: 'U3 done' }); clock += 10
  n.tick()
  ok('three quick finishes are held while they keep coming', sent.length === 1)
  clock += 60
  n.tick()
  ok('...then arrive as ONE push', sent.length === 2 && sent[1].tier === 'batch' && /3 units done/.test(sent[1].title), JSON.stringify(sent[1]))
  for (let i = 0; i < 8; i++) { n.event({ kind: 'done', title: `D${i}` }); clock += 50; n.tick() }
  ok('a steady stream still flushes by the max wait', sent.length >= 3)
  const pa = claudePushArgs('U1 done').join(' ')
  ok('the Claude-app push is a one-tool, no-MCP, unsaved call', /--tools PushNotification/.test(pa) && /--strict-mcp-config/.test(pa) && /--no-session-persistence/.test(pa))
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifycfg-'))
  fs.writeFileSync(path.join(cfgDir, 'n.json'), JSON.stringify({ claudeApp: {} }))
  ok('claudeApp config defaults to haiku', loadChannels(path.join(cfgDir, 'n.json')).claudeApp?.model === 'haiku')
  ok('no config file means Mac only', loadChannels(path.join(cfgDir, 'absent.json')).claudeApp === null)
  fs.rmSync(cfgDir, { recursive: true, force: true })
}

console.log('\n── F6 control tower (MCP protocol)')
{
  const calls = []
  const run = async argv => { calls.push(argv); return { out: `ran ${argv.join(' ')}`, code: 0 } }
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { run })
  ok('initialize answers with tools capability', init.result?.capabilities?.tools && init.result.serverInfo.name === 'harness')
  ok('initialized notification gets no reply', await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { run }) === null)
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { run })
  const names = list.result.tools.map(t => t.name)
  ok('status, history, steer, approve, pause are all offered', ['status', 'history', 'steer', 'approve', 'pause', 'resume'].every(n => names.includes(n)))
  const steer = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'steer', arguments: { message: 'use the fixture' } } }, { run })
  ok('steer maps to `harness say`', calls.at(-1).join(' ') === 'say use the fixture' && !steer.result.isError)
  const denied = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'approve', arguments: { id: 'a001' } } }, { run, agentSession: true })
  ok('a build session cannot approve through the tower', denied.result.isError && !calls.some(c => c[0] === 'approve'))
  const missing = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'steer', arguments: {} } }, { run })
  ok('required arguments are enforced', missing.error?.code === -32602)
  ok('unknown methods error', (await handleMessage({ jsonrpc: '2.0', id: 6, method: 'nope' }, { run })).error?.code === -32601)
  ok('every tool maps to an argv list', Object.values(TOOLS).every(t => Array.isArray(t.argv({ id: 'x', message: 'm' }))))
}

console.log('\n── F3 leak gate (scanner)')
{
  ok('a planted key is found', scanBlob('src/a.js', `const k = "${FAKE_SECRET}"`).some(f => f.kind === 'secret'))
  ok('the report masks the secret', !JSON.stringify(scanBlob('a', FAKE_SECRET)).includes(FAKE_SECRET))
  ok('`leakgate:allow` exempts a deliberate fake', scanBlob('t.py', `KEY = "${FAKE_SECRET}"  # leakgate:allow`).length === 0)
  ok('a .env file is refused by name', scanBlob('app/.env', 'X=1').some(f => f.rule === 'forbidden file'))
  ok('.env.example is fine', scanBlob('app/.env.example', 'X=').length === 0)
  const home = '/Users/' + 'someone' + '/Documents/x'
  ok('a home path is personal data', scanBlob('README.md', `see ${home}`).some(f => f.rule === 'home path'))
  const mobile = ['04', '12 3', '45 6', '78'].join('')
  ok('an AU mobile is personal data', scanBlob('c.md', `call ${mobile}`).some(f => f.rule === 'au phone'))
  const deny = parseDenylist('# private\nAcme Visa Services\n\n')
  ok('denylist terms match case-insensitively', scanBlob('n.md', 'worked at ACME VISA SERVICES', { denylist: deny }).length === 1)
  ok('a clean history passes', mirrorScan([{ path: 'a.js', text: 'export const x = 1' }]).ok)
  ok('mask keeps a short prefix only', mask(FAKE_SECRET).length < 16)
}

console.log('\n── Codex window + limit signals')
{
  const [lim, res] = normalizeProviderEvent('codex', { type: 'turn.failed', error: { message: "You've hit your usage limit. Try again at 3:45 PM." } })
  ok('a Codex usage-limit failure becomes a rejected window event', lim.type === 'rate_limit_event' && lim.rate_limit_info.status === 'rejected')
  ok('...and a 429-shaped result, not a generic error', res.api_error_status === 429)
  const other = normalizeProviderEvent('codex', { type: 'turn.failed', error: { message: 'sandbox denied' } })
  ok('other Codex failures stay errors', other.length === 1 && !other[0].api_error_status)
  const inv = headlessInvocation({ provider: 'codex', repo: '/r', prompt: 'p', disabledMcpServers: ['harness'] })
  ok('codex build sessions run with the control tower switched off', inv.args.join(' ').includes('mcp_servers.harness.enabled=false'))
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codexhome-'))
  ok('no tower registered → nothing to disable (codex rejects unknown servers)', codexOperatorServers(fakeHome).length === 0)
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), '[mcp_servers.harness]\ncommand = "node"\n')
  ok('a registered tower is detected', codexOperatorServers(fakeHome).join() === 'harness')
  ok('no rollouts means unknown (null), never zero', codexWindowReading(fakeHome) === null)
  writeRollout(fakeHome, 97, now() + 600)
  const r = codexWindowReading(fakeHome)
  ok('the newest rollout gives the live 5h reading', r?.five?.pct === 97 && r.five.resetsAt > now())
  fs.rmSync(fakeHome, { recursive: true, force: true })
}

function writeRollout(home, pct, resetsAt) {
  const d = path.join(home, '.codex', 'sessions', '2026', '09', '24')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'rollout-2026-09-24T10-00-00-x.jsonl'), JSON.stringify({
    timestamp: new Date().toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: pct, window_minutes: 300, resets_at: resetsAt }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: resetsAt + 86400 } } },
  }) + '\n')
}

// ═══════════════════════════════════════════ integration: the real CLI
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v2-'))
const REPO = path.join(SANDBOX, 'repo')
const HOME = path.join(SANDBOX, 'home')
const BIN = path.join(SANDBOX, 'bin')
const STATE = path.join(REPO, '.harness')
for (const d of [REPO, HOME, BIN]) fs.mkdirSync(d, { recursive: true })
const g = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
g('init', '-q', '-b', 'main')
g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 'test')
fs.writeFileSync(path.join(REPO, '.gitignore'), '.harness/\n')
fs.writeFileSync(path.join(REPO, '.harness-prompt.md'), '# Goal\nExercise the v2 runner inside a throwaway sandbox repository.\n\n# Constraints\nnone\n\n# Budget\nnone\n\n# Deliverable\nFiles named built-<unit>.txt committed by the fake provider.\n')
fs.writeFileSync(path.join(REPO, '.harness.json'), JSON.stringify({ project: 'v2-sandbox', label: 'com.harness.v2-sandbox', journalPath: 'logs/j.jsonl' }))
g('add', '-A'); g('commit', '-qm', 'init')

// Fake provider CLIs. They build the unit named in the brief (a file, a
// commit) and emit a minimal successful stream in each provider's dialect.
const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const name = path.basename(process.argv[1]), args = process.argv.slice(2)
if (name === 'claude' && !args.includes('-p')) process.exit(0) // interactive attach: open and close
const prompt = name === 'claude' ? args[args.indexOf('-p') + 1] : args[args.length - 1]
const m = /# Unit (\\S+)/.exec(prompt || '')
fs.appendFileSync(path.join(process.cwd(), '.harness', 'provider-calls.log'), name + ' ' + (m ? m[1] : '-') + '\\n')
if (m && !/NEVER/.test(m[1])) {
  fs.writeFileSync('built-' + m[1] + '.txt', name + '\\n')
  execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'unit ' + m[1]])
}
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
if (name === 'claude') {
  const i = args.indexOf('--session-id') >= 0 ? args.indexOf('--session-id') : args.indexOf('--resume')
  out({ type: 'system', subtype: 'init', session_id: args[i + 1] })
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.001, duration_ms: 5, usage: { input_tokens: 10, output_tokens: 5 } })
} else {
  out({ type: 'thread.started', thread_id: '11111111-2222-3333-4444-555555555555' })
  out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })
}
`
for (const n of ['claude', 'codex']) { fs.writeFileSync(path.join(BIN, n), FAKE); fs.chmodSync(path.join(BIN, n), 0o755) }

const ENV = {
  ...process.env, HOME, HARNESS_REPO: REPO, HARNESS_PROVIDER_BIN: BIN, HARNESS_NOTIFY: 'off',
  HARNESS_AGENT_SESSION: '', AGENT_PROVIDER: '',
}
delete ENV.AGENT_PROVIDER
const cli = (args, extra = {}, input = '') => {
  try {
    return { out: execFileSync('node', [H, ...args], { cwd: REPO, env: { ...ENV, ...extra }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 }), code: 0 }
  } catch (e) { return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status ?? 1 } }
}
const setQueue = units => fs.writeFileSync(path.join(REPO, '.harness-units.json'), JSON.stringify({ units }, null, 2))
const runLog = () => { try { return fs.readFileSync(path.join(STATE, 'run.log'), 'utf8') } catch { return '' } }
const notes = () => { try { return fs.readFileSync(path.join(STATE, 'notifications.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
const resetState = () => fs.rmSync(STATE, { recursive: true, force: true })

console.log('\n── F4 on the CLI')
{
  setQueue([{ id: 'X', title: 'prose only', owner: 'agent', acceptance: '' }])
  const r = cli(['units', 'check'])
  ok('`units check` refuses a unit with no acceptance command', r.code === 1 && /REFUSED/.test(r.out), r.out)
  const run = cli(['run', '--until-idle'])
  ok('the runner will not start on an invalid queue', !/RUNNER X/.test(runLog()) && /unit queue invalid/.test(JSON.stringify(notes())), run.out)
}

console.log('\n── F5 acceptance: finish → next unit, no timer')
{
  resetState()
  setQueue([unit('U1'), unit('U2', { depends: ['U1'] })])
  const t0 = Date.now()
  const r = cli(['run', '--until-idle'])
  const secs = (Date.now() - t0) / 1000
  const log = runLog()
  ok('U1 then U2 were built', fs.existsSync(path.join(REPO, 'built-U1.txt')) && fs.existsSync(path.join(REPO, 'built-U2.txt')), r.out.slice(-400))
  const i1 = log.indexOf('RUNNER U1 acceptance PASS'), i2 = log.indexOf('RUNNER U2 → claude')
  ok('U2 started straight after U1 passed', i1 > 0 && i2 > i1, log.slice(-800))
  ok('...with no scheduler interval in between', secs < 45, `${secs}s`)
  ok('`units` shows both done', /✅ U1/.test(cli(['units']).out) && /✅ U2/.test(cli(['units']).out))
}

console.log('\n── F5 acceptance: simulated limit → switch, then park')
{
  resetState()
  setQueue([unit('U1', { status: 'done' }), unit('U3')])
  fs.mkdirSync(STATE, { recursive: true })
  fs.writeFileSync(path.join(STATE, 'usage.jsonl'), JSON.stringify({ at: now(), util: 1, kind: 'five_hour', status: 'rejected', resets_at: now() + 600 }) + '\n')
  const gate = JSON.parse(cli(['gate'], { AGENT_PROVIDER: 'claude' }).out.trim())
  ok('the claude gate reports the spent window', gate.ok === false && gate.resumeAt > now(), JSON.stringify(gate))
  cli(['run', '--until-idle'])
  ok('a capped claude routes the unit to codex', /RUNNER U3 → codex/.test(runLog()), runLog().slice(-500))
  ok('codex built it', fs.readFileSync(path.join(REPO, 'built-U3.txt'), 'utf8').trim() === 'codex')

  setQueue([unit('U1', { status: 'done' }), unit('U3', { status: 'done' }), unit('U4')])
  writeRollout(HOME, 100, now() + 300)
  const cg = JSON.parse(cli(['gate'], { AGENT_PROVIDER: 'codex' }).out.trim())
  ok('the codex gate reads its own rollout meter', cg.ok === false && cg.source === 'rollout', JSON.stringify(cg))
  cli(['run', '--until-idle'])
  ok('both capped → park, nothing spawned', /RUNNER park until/.test(runLog()) && !/RUNNER U4 →/.test(runLog()))
  ok('parking pushes at once', notes().some(n => n.type === 'send' && n.tier === 'immediate' && /parked/.test(n.title)))
  fs.rmSync(path.join(HOME, '.codex'), { recursive: true, force: true })
  fs.rmSync(path.join(STATE, 'usage.jsonl'), { force: true })
}

console.log('\n── F8 acceptance: 3 quick finishes → one push; approval → instant')
{
  resetState()
  setQueue([unit('B1'), unit('B2'), unit('B3')])
  cli(['run', '--until-idle'])
  const n = notes()
  ok('three units finished', n.filter(x => x.type === 'event' && x.kind === 'done').length === 3, JSON.stringify(n))
  const sends = n.filter(x => x.type === 'send' && x.tier === 'batch')
  ok('...and produced exactly one batched push', sends.length === 1 && /3 units done/.test(sends[0].title), JSON.stringify(sends))
  const a = cli(['ask', 'spend', 'buy a domain for $12'])
  ok('an approval request pushes immediately', a.code === 0 && notes().some(x => x.type === 'send' && x.tier === 'immediate' && /approval a001/.test(x.title)))
  const r = cli(['units'])
  ok('failed acceptance is retried then parked', (() => {
    resetState(); setQueue([unit('NEVER1')])
    cli(['run', '--until-idle'])
    return /❌ NEVER1/.test(cli(['units']).out) && notes().some(x => x.type === 'send' && /failed/.test(x.title))
  })(), r.out)
}

console.log('\n── F6 acceptance: the tower over stdio')
{
  resetState()
  cli(['ask', 'spend', 'renew the domain'])
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'steer', arguments: { message: 'prefer the fixture data' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'approve', arguments: { id: 'a001', note: 'cap at $15' } } },
  ].map(m => JSON.stringify(m)).join('\n') + '\n'
  const out = cli(['mcp'], {}, msgs).out.trim().split('\n').map(l => JSON.parse(l))
  const byId = Object.fromEntries(out.map(r => [r.id, r]))
  ok('status comes back through the tower', /scheduler/.test(byId[2]?.result?.content?.[0]?.text || ''), JSON.stringify(byId[2]).slice(0, 200))
  const inbox = fs.readFileSync(path.join(STATE, 'inbox.md'), 'utf8')
  ok('a steer lands in the session inbox', /prefer the fixture data/.test(inbox))
  const last = fs.readFileSync(path.join(STATE, 'approvals.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1)
  ok('an approval is answered, with its condition relayed', last.id === 'a001' && last.status === 'approved' && /cap at \$15/.test(inbox), JSON.stringify(last))
  const agentOut = cli(['mcp'], { HARNESS_AGENT_SESSION: '1' }, [msgs.split('\n')[0], JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'resume', arguments: {} } })].join('\n') + '\n')
  ok('inside a build session the human-only tools refuse', /reserved for the operator/.test(agentOut.out))
  ok('...and so does the CLI', cli(['approve', 'a001'], { HARNESS_AGENT_SESSION: '1' }).code === 1)
}

console.log('\n── F7 acceptance: attach waits for the session to land')
{
  resetState()
  fs.mkdirSync(STATE, { recursive: true })
  // Stand-in for a tick in flight: a live process holding the tick lock.
  // Orphaned via an intermediate shell so launchd reaps it: a direct child of
  // this (sync-blocked) test process would linger as a zombie that still
  // answers kill(pid, 0), and the attach would wait on a session long gone.
  const fakeTick = Number(execFileSync('sh', ['-c', 'sleep 4 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim())
  fs.writeFileSync(path.join(STATE, 'run.lock'), String(fakeTick))
  const attach = spawn('node', [H, 'attach'], { cwd: REPO, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  let aout = ''
  attach.stdout.on('data', c => aout += c); attach.stderr.on('data', c => aout += c)
  const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 100)) } return false }
  const requested = await waitFor(() => fs.existsSync(path.join(STATE, 'attach_request')), 5000)
  ok('attach during a live session files an attach request', requested, aout)
  const inbox = (() => { try { return fs.readFileSync(path.join(STATE, 'inbox.md'), 'utf8') } catch { return '' } })()
  ok('...and tells the session to land', /A HUMAN IS ATTACHING/.test(inbox))
  setQueue([unit('W1')])
  const held = cli(['run', '--until-idle'])
  ok('the runner holds while the attach is pending', /RUNNER hold — a human asked to attach/.test(runLog()), runLog().slice(-600))
  ok('...then builds the queued unit once the human detaches', fs.existsSync(path.join(REPO, 'built-W1.txt')), runLog().slice(-900))
  const code = await new Promise(r => attach.on('close', r))
  ok('attach proceeds once the session lands, then detaches cleanly', code === 0 && /session landed/.test(aout) && /DETACH/.test(runLog()), aout)
  ok('no attach markers are left behind', !fs.existsSync(path.join(STATE, 'attach_request')) && !fs.existsSync(path.join(STATE, 'attached')))
  void held
}

console.log('\n── F3 acceptance: a planted secret blocks the mirror push')
{
  const bare = path.join(SANDBOX, 'public.git')
  execFileSync('git', ['init', '-q', '--bare', bare])
  fs.mkdirSync(path.join(REPO, 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(REPO, 'pkg', 'index.js'), 'export const hello = () => "hi"\n')
  g('add', 'pkg'); g('commit', '-qm', 'pkg')
  fs.writeFileSync(path.join(REPO, 'pkg', 'config.js'), `export const key = "${FAKE_SECRET}"\n`)
  g('add', 'pkg'); g('commit', '-qm', 'oops')
  const blocked = cli(['mirror', 'pkg', '--remote', bare])
  const branches = () => execFileSync('git', ['--git-dir', bare, 'branch'], { encoding: 'utf8' }).trim()
  ok('the push is blocked by the planted secret', blocked.code === 1 && /LEAK GATE BLOCKED/.test(blocked.out), blocked.out)
  ok('...and nothing reached the remote', branches() === '')
  ok('...and the report does not repeat the secret', !blocked.out.includes(FAKE_SECRET))
  // Deleting the file in a new commit is NOT enough — history is public too.
  fs.rmSync(path.join(REPO, 'pkg', 'config.js')); g('add', '-A', 'pkg'); g('commit', '-qm', 'remove key')
  ok('removing it in a later commit still blocks (history is scanned)', cli(['mirror', 'pkg', '--remote', bare]).code === 1)
  g('reset', '-q', '--hard', 'HEAD~2')
  const clean = cli(['mirror', 'pkg', '--remote', bare])
  ok('with the secret rewritten out, the push goes through', clean.code === 0 && /pushed/.test(clean.out), clean.out)
  ok('the public branch holds only the prefix', /index\.js/.test(execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })))
  // Snapshot mode: a public repo whose history predates the monorepo.
  const pub = path.join(SANDBOX, 'legacy.git')
  execFileSync('git', ['init', '-q', '--bare', pub])
  const legacy = path.join(SANDBOX, 'legacy')
  execFileSync('git', ['clone', '-q', pub, legacy])
  fs.writeFileSync(path.join(legacy, 'OLD.md'), 'old public history\n')
  execFileSync('git', ['-C', legacy, 'add', '-A']); execFileSync('git', ['-C', legacy, '-c', 'user.name=o', '-c', 'user.email=o@x.invalid', 'commit', '-qm', 'old'])
  execFileSync('git', ['-C', legacy, 'push', '-q', 'origin', 'HEAD:main'])
  const oldHead = execFileSync('git', ['--git-dir', pub, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()
  ok('a diverged public repo refuses a plain push', cli(['mirror', 'pkg', '--remote', pub]).code === 1)
  const snap = cli(['mirror', 'pkg', '--remote', pub, '--snapshot'])
  ok('--snapshot publishes on top of the public history', snap.code === 0 && /snapshot on top/.test(snap.out), snap.out)
  const newHead = execFileSync('git', ['--git-dir', pub, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()
  ok('...without rewriting it (fast-forward)', execFileSync('git', ['--git-dir', pub, 'rev-parse', `${newHead}^`], { encoding: 'utf8' }).trim() === oldHead)
  ok('...and the public tree is exactly the folder', /index\.js/.test(execFileSync('git', ['--git-dir', pub, 'ls-tree', '--name-only', 'main'], { encoding: 'utf8' })))
  ok('a second snapshot with no change publishes nothing', /nothing to publish/.test(cli(['mirror', 'pkg', '--remote', pub, '--snapshot']).out))
  fs.writeFileSync(path.join(REPO, '.leakgate-deny'), 'Hidden Employer Pty\n')
  fs.writeFileSync(path.join(REPO, 'pkg', 'about.md'), 'Built while at hidden employer pty.\n')
  g('add', 'pkg'); g('commit', '-qm', 'about')
  ok('the private denylist blocks personal data', /denylist/.test(cli(['mirror', 'pkg', '--dry-run']).out))
  ok('an agent session cannot publish', /reserved for the operator/.test(cli(['mirror', 'pkg', '--remote', bare], { HARNESS_AGENT_SESSION: '1' }).out))
  ok('...but may dry-run the gate on its own work', /LEAK GATE BLOCKED|leak gate: clean/.test(cli(['mirror', 'pkg', '--dry-run'], { HARNESS_AGENT_SESSION: '1' }).out))
}

fs.rmSync(SANDBOX, { recursive: true, force: true })
console.log(`\n${'='.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(52)}`)
process.exit(fail ? 1 : 0)
