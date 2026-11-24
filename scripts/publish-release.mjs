#!/usr/bin/env node
// Publish the current build's euler-app.asar as a GitHub release (tag = package.json version).
// Also ensures the GitHub repo exists and pushes the source to main. Auth: GITHUB_TOKEN (classic PAT).
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const slug = 'VulkTek/eulers-harness'
const ver = JSON.parse(readFileSync('package.json', 'utf8')).version
const TAG = `v${ver}`
const H = {
  'User-Agent': 'eulers-harness-publish',
  Authorization: `token ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json'
}

if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN missing — source ~/.hermes/.env first')

// 1. repo exists? create public if not
const repoRes = await fetch(`https://api.github.com/repos/${slug}`, { headers: H })
if (repoRes.status === 404) {
  const cr = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'eulers-harness', description: 'Vulktek standalone AI agent harness (Electron + pi SDK)', private: false })
  })
  if (!cr.ok) throw new Error('repo creation failed: ' + cr.status + ' ' + (await cr.text()).slice(0, 200))
  console.log('repo created:', slug)
} else if (!repoRes.ok) throw new Error('github: ' + repoRes.status)

// 2. push source
if (!existsSync('.git')) execSync('git init', { stdio: 'inherit' })
try { execSync('git branch -M main', { stdio: 'pipe' }) } catch { /* fine */ }
execSync('git add -A', { stdio: 'pipe' })
try { execSync(`git commit -m "release ${TAG}"`, { stdio: 'pipe' }) } catch { /* nothing new */ }
try { execSync(`git remote add origin https://github.com/${slug}.git`, { stdio: 'pipe' }) } catch { /* exists */ }
execSync('git push -u origin main', { stdio: 'inherit' })

// 3. release (idempotent by tag)
let relJson
const relCreate = await fetch(`https://api.github.com/repos/${slug}/releases`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tag_name: TAG, name: `Euler's Harness ${TAG}`, body: `App layer ${TAG}. The update chip in the app checks the latest release, downloads euler-app.asar, swaps it in and relaunches. No auth needed: public repo.` })
})
if (relCreate.ok) {
  relJson = await relCreate.json()
} else {
  const tagRes = await fetch(`https://api.github.com/repos/${slug}/releases/tags/${TAG}`, { headers: H })
  if (!tagRes.ok) throw new Error('release create failed: ' + relCreate.status + ' ' + (await relCreate.text()).slice(0, 200))
  relJson = await tagRes.json()
}

// 4. upload asset (replace if already present)
const assetRes = await fetch(`https://api.github.com/repos/${slug}/releases/${relJson.id}/assets?per_page=100`, { headers: H })
if (assetRes.ok) {
  for (const a of (await assetRes.json())) {
    if (a.name === 'euler-app.asar') await fetch(`https://api.github.com/repos/${slug}/releases/assets/${a.id}`, { method: 'DELETE', headers: H })
  }
}
const asar = readFileSync('release/win-unpacked/resources/app.asar')
const up = await fetch(`https://uploads.github.com/repos/${slug}/releases/${relJson.id}/assets?name=euler-app.asar`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/octet-stream' },
  body: asar
})
if (!up.ok) throw new Error('asset upload failed: ' + up.status + ' ' + (await up.text()).slice(0, 200))
// 5. wait until the PUBLIC unauthenticated /releases/latest actually reports this tag
// (api.github.com can briefly serve a cached previous "latest"; the app's update chip reads exactly this endpoint,
// so a fresh publish must be visible before we declare success)
const H0 = { 'User-Agent': 'eulers-harness-publish' }
let seenTag = ''
for (let i = 0; i < 20; i++) {
  const pub = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, { headers: H0 })
  if (pub.ok) {
    const j = await pub.json()
    seenTag = j.tag_name
    if (seenTag === TAG) break
  }
  await new Promise(r => setTimeout(r, 2000))
}
if (seenTag !== TAG) throw new Error(`public /releases/latest still reports ${seenTag || 'nothing'} after 40s`)
console.log('public latest confirmed:', seenTag)
console.log(`published ${TAG} (${(asar.length / 1024 / 1024).toFixed(1)} MB) - https://github.com/${slug}/releases/tag/${TAG}`)
