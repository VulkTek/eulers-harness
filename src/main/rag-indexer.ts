// P7: RAG indexer — chunk files from ragDocsDir, embed via OpenAI-compatible /embeddings, store Float32 vector bin + index.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

interface Chunk { i: number; file: string; text: string }
interface RagIndex { dim: number; chunks: Chunk[]; createdAt: number; embedUrl: string }

const CHUNK_CHARS = 1400
const CHUNK_OVERLAP = 150
const EXTS = ['.txt', '.md', '.json', '.csv', '.log', '.html', '.pdf']

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (EXTS.includes(extname(p).toLowerCase())) out.push(p)
  }
  return out
}

function chunkText(text: string): string[] {
  const chunks: string[] = []
  // split on natural boundaries first
  const paras = text.split(/\n\s*\n|\r\n\s*\r\n/)
  let buf = ''
  for (const para of paras) {
    if ((buf + para).length > CHUNK_CHARS && buf.length > 200) {
      chunks.push(buf.trim())
      buf = buf.slice(Math.max(0, buf.length - CHUNK_OVERLAP))
    }
    buf += (buf ? '\n\n' : '') + para
  }
  if (buf.trim().length > 20) chunks.push(buf.trim())
  return chunks
}

export async function embedBatch(url: string, inputs: string[], apiKey?: string): Promise<number[][]> {
  const res = await fetch(url.replace(/\/$/, '') + '/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
    body: JSON.stringify({ input: inputs, model: 'nomic-embed-text' })
  })
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
  const data = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }> }
  const arr = data.data ?? []
  const sorted = [...arr].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return sorted.map(d => d.embedding)
}

export interface IndexProgress {
  (phase: 'start' | 'progress' | 'done' | 'error', done: number, total: number, message?: string): void
}

export async function indexDocsDir(docsDir: string, embedUrl: string, eulerDir: string, apiKey: string | undefined, onProgress: IndexProgress): Promise<{ chunks: number; files: number }> {
  const ragDir = join(eulerDir, 'rag')
  mkdirSync(ragDir, { recursive: true })
  const files = walk(docsDir)
  if (files.length === 0) throw new Error('no indexable files found (txt, md, json, csv, log, html)')
  onProgress('start', 0, files.length)
  const chunks: Chunk[] = []
  let dim = 0
  let done = 0
  const texts: string[] = []
  const meta: Array<{ file: string; text: string }> = []
  for (const file of files) {
    if (extname(file).toLowerCase() === '.pdf') continue // pdf text extraction: P7.1, uses system tooling
    let content: string
    try { content = readFileSync(file, 'utf8') } catch { done++; continue }
    const pieces = chunkText(content)
    for (const piece of pieces) {
      meta.push({ file, text: piece })
      texts.push(piece.slice(0, 6000))
    }
    done++
    onProgress('progress', done, files.length, file)
  }
  // embed in batches
  const allVecs: number[][] = []
  const BATCH = 32
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
    const vecs = await embedBatch(embedUrl, batch, apiKey)
    if (dim === 0 && vecs.length > 0) dim = vecs[0].length
    allVecs.push(...vecs)
    onProgress('progress', Math.min(texts.length, i + BATCH), texts.length, `embedding ${i + batch.length}/${texts.length}`)
  }
  // write vectors
  const bin = new Float32Array(allVecs.length * dim)
  allVecs.forEach((vec, i) => bin.set(vec, i * dim))
  const toWrite = Buffer.from(bin.buffer)
  writeFileSync(join(ragDir, 'vectors.bin'), toWrite)
  // write index
  const index: RagIndex = { dim, chunks: meta.map((entry, i) => ({ i, file: entry.file, text: entry.text })), createdAt: Date.now(), embedUrl }
  writeFileSync(join(ragDir, 'index.json'), JSON.stringify(index))
  onProgress('done', allVecs.length, allVecs.length)
  return { chunks: allVecs.length, files: files.length }
}

export function ragStatus(eulerDir: string): { indexed: boolean; chunks: number; files: number } {
  const idxPath = join(eulerDir, 'rag', 'index.json')
  if (!existsSync(idxPath)) return { indexed: false, chunks: 0, files: 0 }
  try {
    const index = JSON.parse(readFileSync(idxPath, 'utf8')) as RagIndex
    return { indexed: true, chunks: index.chunks.length, files: new Set(index.chunks.map(c => c.file)).size }
  } catch {
    return { indexed: false, chunks: 0, files: 0 }
  }
}
