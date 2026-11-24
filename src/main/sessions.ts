// SessionStore: per-user session metadata + full message transcripts in ~/.euler/sessions.
// pi SDK persists its own session JSONLs separately; this store mirrors what the UI needs
// (list, transcripts, name) and will back Ctrl+F at P5 via FTS5.
import Database from 'better-sqlite3'
import { join } from 'path'

export interface SessionRow {
  id: string
  name: string
  createdAt: number
  lastActive: number
  messageCount: number
}

export interface MessageRow {
  id: number
  sessionId: string
  role: string
  content: string
  timestamp: number
  toolCalls: string | null
  error: string | null
}

export class SessionStore {
  private db: Database.Database
  private eulerDir: string

  constructor(eulerDir: string) {
    this.eulerDir = eulerDir
    this.db = new Database(join(eulerDir, 'sessions.db'))
    this.db.pragma('journal_mode = WAL')
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tool_calls TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    `)
    this.ensureFts()
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM messages_fts').get() as { c: number }).c
    if (count === 0) {
      this.db.exec(`INSERT INTO messages_fts(rowid, content, role, session_id) SELECT id, content, role, session_id FROM messages`)
    }  }

  createSession(id: string, name: string): void {
    this.db.prepare('INSERT OR IGNORE INTO sessions (id, name, created_at, last_active) VALUES (?, ?, ?, ?)')
      .run(id, name, Date.now(), Date.now())
  }

  renameSession(id: string, name: string): void {
    this.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id)
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  listSessions(): SessionRow[] {
    return this.db.prepare('SELECT id, name, created_at as createdAt, last_active as lastActive, message_count as messageCount FROM sessions ORDER BY last_active DESC').all() as SessionRow[]
  }

  addMessage(sessionId: string, role: string, content: string, timestamp: number, toolCalls: string | null, error: string | null): void {
    this.db.prepare('INSERT INTO messages (session_id, role, content, timestamp, tool_calls, error) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, role, content, timestamp, toolCalls, error)
    this.db.prepare('UPDATE sessions SET last_active = ?, message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?) WHERE id = ?')
      .run(Date.now(), sessionId, sessionId)
  }

  getMessages(sessionId: string): MessageRow[] {
    return this.db.prepare('SELECT id, session_id as sessionId, role, content, timestamp, tool_calls as toolCalls, error FROM messages WHERE session_id = ? ORDER BY id').all(sessionId) as MessageRow[]
  }

  private ensureFts(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, role, session_id UNINDEXED,
        content='messages', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, role, session_id) VALUES (new.id, new.content, new.role, new.session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, role, session_id) VALUES('delete', old.id, old.content, old.role, old.session_id);
      END;
    `)
  }

  searchAll(query: string, limit = 40): Array<{ sessionId: string; sessionName: string; role: string; content: string; ts: number }> {
    this.ensureFts()
    const safe = query.replace(/["']/g, ' ').trim()
    if (!safe) return []
    // prefix match on last word for live search feel
    const terms = safe.split(/\s+/).map(t => t + '*').join(' ')
    // fts carries no ts column (it was dropped with the external-content schema); timestamp joins from messages via rowid
    return this.db.prepare(`
      SELECT f.session_id as sessionId, s.name as sessionName, f.role, substr(f.content, 1, 220) as content, m.timestamp as ts
      FROM messages_fts f
      JOIN messages m ON m.id = f.rowid
      LEFT JOIN sessions s ON s.id = f.session_id
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(terms, limit) as Array<{ sessionId: string; sessionName: string; role: string; content: string; ts: number }>
  }

  close(): void {
    this.db.close()
  }
}
