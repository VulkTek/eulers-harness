// euler-rag: search_docs tool for the model. Reads index from ~/.euler/rag/, embeds query via HTTP.
// Index format: index.json {chunk: {id, file, text, startPos}} + vectors.bin (Float32Array little-endian).
// Cosine in plain JS at small-corpus scale (fits plan).
const EMBED_URL = () => process.env.EULER_EMBED_URL ?? ''
const RAG_DIR = () => (process.env.EULER_HOME ?? '') + '/rag'
const COS_THRESHOLD = 0.25
const TOP_K = 5

async function embed(text) {
  const url = EMBED_URL()
  if (!url) throw new Error('embedding endpoint not configured')
  const res = await fetch(url.replace(/\/$/, '') + '/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.EULER_API_KEY ? { authorization: 'Bearer ' + process.env.EULER_API_KEY } : {}) },
    body: JSON.stringify({ input: text, model: 'nomic-embed-text' })
  })
  if (!res.ok) throw new Error('embed failed: HTTP ' + res.status)
  const data = await res.json()
  const vec = data?.data?.[0]?.embedding
  if (!Array.isArray(vec)) throw new Error('embed response missing embedding')
  return vec
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

export default function eulerRag(pi) {
  pi.registerTool({
    name: 'search_docs',
    label: 'Search docs',
    description: "Search the owner's private document collection (RAG). Returns the most relevant passages with file names. Use when a question might be answered by their own files.",
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for, natural language' } }, required: ['query'] },
    async execute(_id, params) {
      try {
        const { readFileSync, existsSync } = globalThis.__eulerNodeFs
        const index = JSON.parse(readFileSync(RAG_DIR() + '/index.json', 'utf8'))
        const buf = readFileSync(RAG_DIR() + '/vectors.bin')
        const dim = index.dim
        const n = index.chunks.length
        const queryVec = await embed(params.query)
        const scores = []
        for (let i = 0; i < n; i++) {
          const start = i * dim * 4
          const slice = new Float32Array(buf.buffer, buf.byteOffset + start, dim)
          scores.push({ i, score: cosine(queryVec, Array.from(slice)) })
        }
        scores.sort((a, b) => b.score - a.score)
        const top = scores.filter(s => s.score >= COS_THRESHOLD).slice(0, TOP_K)
        if (top.length === 0) {
          return { content: [{ type: 'text', text: 'No document matches above the relevance threshold.' }], details: {} }
        }
        const text = top.map(s => `[${index.chunks[s.i].file}] (relevance ${(s.score * 100).toFixed(0)}%)\n${index.chunks[s.i].text}`).join('\n\n---\n\n')
        return { content: [{ type: 'text', text }], details: { matches: top.length } }
      } catch (e) {
        return { content: [{ type: 'text', text: 'search_docs unavailable: ' + String(e) }], details: {}, isError: true }
      }
    }
  })
}
