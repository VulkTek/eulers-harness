// Euler's Harness self-updater: compare + fetch euler-app.asar from GitHub releases, staged swap, relaunch.
// Zero-dependency and auth-less: every device updates itself from its own public GitHub repo.
import { app, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { openSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { Writable } from 'stream'

const REPO = 'VulkTek/eulers-harness'
const ASSET_NAME = 'euler-app.asar'

export interface UpdateCheck {
  current: string
  latest: string | null
  updateAvailable: boolean
  assetUrl: string | null
  dev: boolean
  error?: string
}

const parts = (s: string): number[] => (s || '0').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)

const newer = (latest: string, current: string): boolean => {
  const a = parts(latest), b = parts(current)
  if (a[0] !== b[0]) return a[0] > b[0]
  if (a[1] !== b[1]) return a[1] > b[1]
  return (a[2] ?? 0) > (b[2] ?? 0)
}

const send = (win: BrowserWindow | undefined, channel: string, payload: unknown): void => {
  try { win?.webContents.send(channel, payload) } catch { /* window may be closing */ }
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const current = app.getVersion()
  if (!app.isPackaged) return { current, latest: null, updateAvailable: false, assetUrl: null, dev: true }
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'eulers-harness', Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return { current, latest: null, updateAvailable: false, assetUrl: null, dev: false, error: `github ${res.status}` }
    const rel = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string; size: number }[] }
    const latest = (rel.tag_name ?? '').replace(/^v/, '')
    const asset = rel.assets?.find(a => a.name === ASSET_NAME)
    if (!latest || !asset) return { current, latest: latest || null, updateAvailable: false, assetUrl: null, dev: false }
    return { current, latest, updateAvailable: newer(latest, current), assetUrl: asset.browser_download_url, dev: false }
  } catch (err) {
    return { current, latest: null, updateAvailable: false, assetUrl: null, dev: false, error: String(err).slice(0, 120) }
  }
}

export async function applyUpdate(win: BrowserWindow | undefined): Promise<{ started: boolean; error?: string }> {
  if (!app.isPackaged) return { started: false, error: 'dev build, update via git + npm' }
  const chk = await checkForUpdate()
  if (!chk.updateAvailable || !chk.assetUrl) return { started: false, error: chk.error ?? 'no update available' }
  const asarPath = app.getAppPath() // .../resources/app.asar
  const stage = `${asarPath}.new`
  try {
    const res = await fetch(chk.assetUrl, { headers: { 'User-Agent': 'eulers-harness' } })
    if (!res.ok || !res.body) return { started: false, error: `download failed (${res.status})` }
    const total = Number(res.headers.get('content-length') ?? 0)
    const reader = res.body.getReader()
    const chunks: Buffer[] = []
    let got = 0
    let lastPct = -1
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      got += value.length
      if (total > 0) {
        const pct = Math.round((got / total) * 100)
        if (pct !== lastPct) { lastPct = pct; send(win, 'updater:progress', pct) }
      }
    }
    const buf = Buffer.concat(chunks)
    // sanity: an asar begins with a small pickle header, then {"files": ...}
    if (buf.subarray(0, 4096).indexOf('"files"') === -1) {
      send(win, 'updater:done', { relaunching: false, error: 'download failed integrity check' })
      return { started: false, error: 'download failed integrity check' }
    }
    writeFileSync(stage, buf)
    const exe = process.execPath
    const pid = String(process.pid)
    const args = process.argv.slice(1).filter(a => a.length > 0)
    const argsStr = args.length > 0 ? ' ' + args.map(a => `'${a}'`).join(' ') : ''
    let child
    if (process.platform === 'win32') {
      const argsStrC = args.length > 0 ? ' ' + args.map(a => `"${a}"`).join(' ') : ''
      const logPath = join(dirname(asarPath), 'update-log.txt')
      // cmd.exe, not powershell: powershell.exe cold-starts slowly (Defender scans it), and
      // app.exit() fires at +400ms — the spawn can be cancelled before CreateProcess completes.
      const logQ = logPath.replace(/"/g, '\\"')
      const script = `echo swap start >> "${logQ}" & ping -n 2 127.0.0.1 >nul & move /y "${stage}" "${asarPath}" >nul 2>&1 & echo swap applied >> "${logQ}" & start "" "${exe}"${argsStrC} & echo swap done >> "${logQ}"`
      child = spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true })
    } else {
      const logPath = join(dirname(asarPath), 'update-log.txt')
      const logFd = openSync(logPath, 'a')
      const script = `echo "swap start \\$(date -Iseconds)"; while kill -0 ${pid} 2>/dev/null; do sleep 0.4; done; sleep 0.5; mv -f '${stage}' '${asarPath}' && echo 'swap applied' && exec '${exe}'${argsStr} || echo 'SWAP-FAILED'`
      child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', logFd, logFd] })
    }
    child.unref()
    statSync(stage)
    send(win, 'updater:done', { relaunching: true, version: chk.latest })
    setTimeout(() => app.exit(0), 400)
    return { started: true }
  } catch (err) {
    try { renameSync(stage, stage) } catch { /* nothing staged */ }
    const msg = String(err).slice(0, 140)
    send(win, 'updater:done', { relaunching: false, error: msg })
    return { started: false, error: msg }
  }
}
