// Permission gate classifier — pure functions, no imports. Unit-testable in CI.
// Tiering: 'auto' runs free, 'approve' asks the user, 'block' refuses then asks.
// Read-only file tools inside/euler + workspace auto; bash classified by pattern.

export type GateTier = 'auto' | 'approve' | 'block'

const DESTRUCTIVE = [
  /\brm\s+(?:-\w*\s+)*-[a-su-zA-SU-Z]*[rR][a-zA-Z]*\s+(?:-\w*\s+)*f?(?:f\w*\s+)?/i, // rm with -r variants (not --interactive-only)
  /\brm\s+(?:-\w*\s+)*-[a-zA-Z]*f[a-zA-Z]*r?\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\b[^|]*\bof=\/dev\//i,
  /\bfdisk\b/i,
  /\bparted\b/i,
  /\bwipefs\b/i,
  /\bshred\b/i,
  /\buserdel\b/i,
  /\bgroupdel\b/i,
  /\bvisudo\b/i,
  /\bpasswd\b/i,
  /\bkill\s+-9\s+1\b/,
  /\bkillall\b/i,
  /\biptables\s+-F\b/,
  /\bnft\s+flush\b/i,
  /\bsystemctl\s+(disable|mask|reset-failed)\s+(sshd|firewall|ufw|fail2ban)/i,
]

const NETWORK = [
  /^curl\b/,
  /^wget\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\brsync\b.*@/,
  /\bnc\b/,
  /\btelnet\b/,
  /\bdocker\s+pull\b/,
  /\bgit\s+push\b/,
  /\bpip\s+install\b/,
  /\bnpm\s+install\b/,
  /\bapt\s+install\b/,
  /\bdnf\s+install\b/,
  /\bbrew\s+install\b/,
  /\bunshare\b/,
]

const SYSTEM_DIRS = /(^|\s)(\/etc|\/boot|\/usr|\/bin|\/sbin|\/var\/lib|\/sys|\/proc|\/dev)\b/
const EULER_DATA = /(^|\s)(~\/\.euler|\/home\/[^/]+\/\.euler|C:\\Users\\[^\\]+\\\.euler|\.euler)\b/

export function classifyBash(command: string): GateTier {
  for (const p of DESTRUCTIVE) if (p.test(command)) return 'block'
  for (const p of NETWORK) if (p.test(command)) return 'approve'
  if (SYSTEM_DIRS.test(command)) return 'approve'
  return 'auto'
}

export function classifyFileTool(toolName: string, path: string | undefined, workspace: string): GateTier {
  if (toolName === 'read') {
    // reads are auto except .euler internals (protect credentials/memory from the model)
    if (path && EULER_DATA.test(path)) return 'approve'
    return 'auto'
  }
  // write/edit
  if (!path) return 'approve'
  if (EULER_DATA.test(path)) return 'block'
  if (SYSTEM_DIRS.test(path)) return 'approve'
  // outside workspace → approve, inside workspace → auto (block only on obvious dotfile secrets)
  const normalizedWorkspace = workspace.replace(/\/$/, '')
  if (normalizedWorkspace && !path.startsWith(normalizedWorkspace) && !path.startsWith('~')) return 'approve'
  if (/\.(env|pem|key|kdbx|gpg)$/.test(path)) return 'approve'
  return 'auto'
}

// Tiers for the modal: block asks forgiveness-after-refusal ("allow once?"), approve asks, auto silent.
export function gateBash(command: string, workspace: string): { tier: GateTier } {
  void workspace
  return { tier: classifyBash(command) }
}
