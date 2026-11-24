// Demo fixtures: pre-recorded session transcripts for the no-key first-run preview.
// Replay is renderer-only: no pi calls, no provider needed.
export interface DemoMsg { role: 'user' | 'assistant'; content: string; toolCalls?: Array<{ toolName: string; args: Record<string, unknown>; result?: string }> }
export interface DemoSession { name: string; messages: DemoMsg[] }

export const DEMO_SESSIONS: DemoSession[] = [
  {
    name: 'Demo: file work',
    messages: [
      { role: 'user', content: 'Create a project note listing the three phases of our launch plan.' },
      {
        role: 'assistant',
        content: 'I checked the workspace first, then wrote the note.\n\n```markdown\n# Launch Plan\n\n1. **Alpha** — internal smoke test with the core toolset\n2. **Beta** — friends-and-family build, feedback rounds\n3. **Stable** — public installer + auto-update\n```\n\nWritten to `launch-plan.md` in the workspace.',
        toolCalls: [
          { toolName: 'write', args: { path: 'launch-plan.md' }, result: 'Wrote 12 lines' }
        ]
      },
      { role: 'user', content: 'What is the third phase again?' },
      { role: 'assistant', content: 'Stable, the public installer with auto-update. Full text is in the file if you want the exact wording.' }
    ]
  },
  {
    name: 'Demo: code review',
    messages: [
      { role: 'user', content: 'Review this snippet for security issues:\n\n```js\nconst { exec } = require(\'child_process\')\nexec(`ping ${req.query.host}`)\n```' },
      {
        role: 'assistant',
        content: 'Command injection risk. `req.query.host` flows straight into a shell string; a host value like `example.com; rm -rf /` executes as two commands.\n\nFix: validate against an allowlist, or skip the shell entirely:\n\n```js\nconst { execFile } = require(\'child_process\')\nif (!/^[a-z0-9.\-]+$/i.test(req.query.host)) return res.status(400).end()\nexecFile(\'ping\', [req.query.host])\n```\n\nTwo hardenings: allowlist before reach, `execFile` never spawns a shell.'
      }
    ]
  }
]
