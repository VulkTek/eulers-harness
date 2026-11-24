// Stand-in vLLM: OpenAI-compatible /v1/models on port 8000 (proves cross-source discovery).
import http from 'http'
const srv = http.createServer((req, res) => {
  if (req.url?.includes('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'Qwen2.5-7B-Instruct-vLLM-TEST' }, { id: 'llama-3.1-8b-vLLM-TEST' }] }))
  } else {
    res.writeHead(404); res.end()
  }
})
srv.listen(8000, '127.0.0.1', () => console.log('fake vllm up on 8000'))
