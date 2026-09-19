// Minimal environment for provider processes. Authentication should come from
// the provider CLI's signed-in/keychain state, never an inherited API key.
export const BASE_ENV_NAMES = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
]

export const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|COOKIE|AUTH)/i

export function sanitizedEnv(source, { allowlist = [], extraPath = [] } = {}) {
  const names = new Set([...BASE_ENV_NAMES, ...allowlist])
  const env = {}
  for (const name of names) {
    if (SECRET_ENV_NAME.test(name)) {
      throw new Error(`refusing to pass secret-shaped environment variable ${name}; use provider CLI sign-in/keychain auth`)
    }
    if (source[name] !== undefined) env[name] = source[name]
  }
  env.PATH = [...extraPath, source.PATH || ''].filter(Boolean).join(':')
  return env
}
