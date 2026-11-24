// Read-only diagnosis of live sessions.db: counts, reproduce searchAll SQL error, trial fixed query.
import Database from 'better-sqlite3'
const db = new Database('/var/home/phoenixphoenix/.euler/sessions.db', { readonly: true })
const msgs = db.prepare('SELECT COUNT(*) c FROM messages').get().c
console.log('messages rows:', msgs)
console.log('sessions rows:', db.prepare('SELECT COUNT(*) c FROM sessions').get().c)
console.log('fts rows:', db.prepare('SELECT COUNT(*) c FROM messages_fts').get().c)
console.log('sample content:', JSON.stringify(db.prepare('SELECT id, substr(content,1,80) s FROM messages ORDER BY id DESC LIMIT 3').all()))
// reproduce the exact searchAll statement from src/main/sessions.ts
try {
  const terms = 'doppler*'
  const bad = db.prepare(`
    SELECT f.session_id as sessionId, s.name as sessionName, f.role, substr(f.content, 1, 220) as content, f.ts
    FROM messages_fts f
    LEFT JOIN sessions s ON s.id = f.session_id
    WHERE messages_fts MATCH ?
    ORDER BY rank
    LIMIT 40
  `)
  console.log('BAD QUERY PREPARED OK?? rows:', bad.all(terms).length)
} catch (e) {
  console.log('BAD QUERY (reproduced):', String(e.message || e).slice(0, 200))
}
// trial fixed query: join messages for timestamp
try {
  const fixed = db.prepare(`
    SELECT f.session_id as sessionId, s.name as sessionName, f.role, substr(f.content, 1, 220) as content, m.timestamp as ts
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    LEFT JOIN sessions s ON s.id = f.session_id
    WHERE messages_fts MATCH ?
    ORDER BY rank
    LIMIT 40
  `)
  console.log('FIXED QUERY rows:', fixed.all('doppler*').length, JSON.stringify(fixed.all('doppler*').slice(0, 2)))
} catch (e) {
  console.log('FIXED QUERY err:', String(e.message || e).slice(0, 200))
}
db.close()
