// Euler's Harness self-updater: compare + fetch euler-app.asar from GitHub releases, staged swap, relaunch.
// Zero-dependency and auth-less: every device updates itself from its own public GitHub repo.
import { app, BrowserWindow } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { closeSync, openSync, renameSync, statSync, writeFileSync, writeSync } from 'fs'
import { basename, dirname, join } from 'path'
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

// Ensure the Windows relaunch Scheduled Task exists (created once on first launch).
// Every device self-registers, so a fresh install is drop-and-go: the update swapper
// can always relaunch via this task. Linux needs no task (the swapper execs directly).
export function ensureLaunchTask(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  try {
    const q = spawnSync('schtasks', ['/Query', '/TN', 'EulerStart'], { stdio: 'ignore' })
    if (q.status === 0) return
    const args = process.argv.slice(1).map(a => `"${a}"`).join(' ')
    const tr = `"${process.execPath}"` + (args ? ' ' + args : '')
    spawnSync('schtasks', ['/Create', '/TN', 'EulerStart', '/SC', 'ONCE', '/ST', '23:59', '/F', '/TR', tr], { stdio: 'ignore' })
  } catch { /* non-fatal: the swapper falls back to a direct start */ }
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
    const argsStrC = args.length > 0 ? ' ' + args.map(a => `"${a}"`).join(' ') : ''
    if (process.platform === 'win32') {
      // No spawn-then-exit race: the app is killed by the swap task itself, the swap runs
      // inside Task Scheduler's own session (independent of the app's lifetime), and the
      // relaunch goes through the existing EulerStart task.
      const resDir = dirname(asarPath)
      const logPath = join(resDir, 'update-log.txt')
      const swapScript = join(resDir, 'swap.cmd')
      const exeName = basename(exe)
      const L = `>> "${logPath}"`
      writeFileSync(swapScript, [
        '@echo off',
        `echo swap start ${L}`,
        `taskkill /F /IM "${exeName}" >nul 2>&1`,
        'ping -n 2 127.0.0.1 >nul',
        `move /y "${stage}" "${asarPath}"`,
        `echo swap applied ${L}`,
        `schtasks /run /tn "EulerStart" >nul 2>&1`,
        `echo relaunch-rc:%ERRORLEVEL% ${L}`,
        `if errorlevel 1 start "" "${exe}"${argsStrC} >nul 2>&1`,
        `schtasks /delete /tn "EulerSwap" /f >nul 2>&1`,
        `echo swap done ${L}`
      ].join('\r\n') + '\r\n')
      // fd stdio is safe here: spawnSync blocks, no detached flag involved.
      const logFd = openSync(logPath, 'a')
      const logLine = (s: string): void => { try { writeSync(logFd, s + '\n') } catch { /* best effort */ } }
      const created = spawnSync('schtasks', ['/Create', '/TN', 'EulerSwap', '/SC', 'ONCE', '/ST', '00:00', '/F', '/TR', swapScript], { stdio: ['ignore', logFd, logFd] })
      logLine('sched-create rc:' + String(created.status) + (created.error ? ' err:' + String(created.error).slice(0, 120) : ''))
      let scheduledOk = created.status === 0
      if (scheduledOk) {
        const ran = spawnSync('schtasks', ['/Run', '/TN', 'EulerSwap'], { stdio: ['ignore', logFd, logFd] })
        logLine('sched-run rc:' + String(ran.status))
        scheduledOk = ran.status === 0
      }
      if (scheduledOk) {
        // fire-and-forget noop keeps the child bookkeeping identical to the linux path
        child = spawn('cmd.exe', ['/c', 'echo noop'], { detached: true, stdio: 'ignore', windowsHide: true })
      } else {
        // fallback: direct detached swapper, self-logging, best effort before app exit
        const logQ = logPath.replace(/"/g, '')
        const direct = `echo fb-swap start >> "${logQ}" & ping -n 2 127.0.0.1 >nul & move /y "${stage}" "${asarPath}" >> "${logQ}" 2>&1 & echo fb-swap applied >> "${logQ}" & start "" "${exe}"${argsStrC} & echo fb-swap done >> "${logQ}"`
        logLine('falling back to direct spawn')
        child = spawn('cmd.exe', ['/c', direct], { detached: true, stdio: 'ignore', windowsHide: true })
        return { started: true }
      }
      closeSync(logFd)
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
