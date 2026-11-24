// euler-permission-gate: pi extension wired into every session by PiHost.
// Blocks/approves tool calls via ctx.ui (bridged to GUI by bindExtensions uiContext override).
// Also injects euler memory context (soul.md/user.md) with untrusted-data fences at session_start.
const DESTRUCTIVE = [
  /\brm\s+(?:-\w+\s+)*-{1,2}[a-zA-Z]*r[a-zA-Z]*f/i,
  /\brm\s+(?:-\w+\s+)*-{1,2}[a-zA-Z]*f[a-zA-Z]*r/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\b[^|]*\bof=\/dev\//i,
  /\bfdisk\b/i,
  /\bparted\b/i,
  /\bwipefs\b/i,
  /\bshred\b/i,
  /\buserdel\b/i,
  /\bkillall\b/i,
  /\biptables\s+-F\b/i,
]
const NETWORK = [
  /^(sudo\s+)?(curl|wget)\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\bnc\b/,
  /\btelnet\b/,
  /\bdocker\s+pull\b/,
  /\bgit\s+push\b/,
  /\b(npm|pip|apt|dnf|brew)\s+install\b/,
]
const SYSTEM_DIRS = /(^|\s)(\/etc\/|\/boot\/|\/usr\/|\/bin\/|\/sbin\/|\/var\/lib\/|\/sys\/|\/proc\/|\/dev\/)/
const PROTECTED = /\.env|\.pem|\.key|\.kdbx|id_rsa|id_ed25519/

export default function eulerGate(pi) {
  pi.on('tool_call', async (event, ctx) => {
    const workspace = ctx.cwd
    if (event.toolName === 'bash') {
      const cmd = String(event.input?.command ?? '')
      for (const p of DESTRUCTIVE) {
        if (p.test(cmd)) {
          const ok = await ctx.ui.confirm('Blocked command', `This will run: ${cmd.slice(0, 200)}\nIt matches a destructive pattern. Allow anyway?`)
          if (!ok) return { block: true, reason: 'destructive command not approved' }
          return
        }
      }
      for (const p of NETWORK) {
        if (p.test(cmd)) {
          const ok = await ctx.ui.confirm('Network command', `This reaches the network: ${cmd.slice(0, 200)}\nAllow?`)
          if (!ok) return { block: true, reason: 'network command not approved' }
          return
        }
      }
      if (SYSTEM_DIRS.test(cmd)) {
        const ok = await ctx.ui.confirm('System path', `This touches a system path: ${cmd.slice(0, 200)}\nAllow?`)
        if (!ok) return { block: true, reason: 'system path write not approved' }
      }
      return
    }
    if (event.toolName === 'write' || event.toolName === 'edit') {
      const path = String(event.input?.path ?? event.input?.file_path ?? '')
      if (!path) return
      if (PROTECTED.test(path) || /(^|\/|\\)\.euler(\/|\\|$)/.test(path)) {
        const ok = await ctx.ui.confirm('Protected path', `${event.toolName} on ${path} touches protected files. Allow?`)
        if (!ok) return { block: true, reason: 'protected path not approved' }
        return
      }
      if (SYSTEM_DIRS.test(path)) {
        const ok = await ctx.ui.confirm('System path', `${event.toolName} on ${path} is outside the workspace. Allow?`)
        if (!ok) return { block: true, reason: 'system path not approved' }
      }
      return
    }
    // read: silent unless protected
    if (event.toolName === 'read') {
      const path = String(event.input?.path ?? event.input?.file_path ?? '')
      if (path && PROTECTED.test(path)) {
        const ok = await ctx.ui.confirm('Protected path', `Reading ${path} (may contain secrets). Allow?`)
        if (!ok) return { block: true, reason: 'protected read not approved' }
      }
    }
  })
}
