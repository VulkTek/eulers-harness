/* Euler's Harness P0 probe: verify pi SDK streaming + tool use against local ollama.
 * Uses in-memory session; agent dir ./.euler-agent holds models.json (ollama endpoint).
 */
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

const events = [];
const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory() });
session.subscribe((e) => {
  if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') {
    process.stdout.write(e.assistantMessageEvent.delta);
    events.push('delta');
  }
  if (e.type === 'tool_execution_start') {
    events.push('tool:' + e.toolName);
    process.stdout.write(`\n[tool: ${e.toolName}]\n`);
  }
  if (e.type === 'tool_execution_end') {
    events.push('tool-end:' + e.toolName);
  }
  if (e.type === 'message_end' && e.message?.role === 'assistant') {
    events.push('usage:' + JSON.stringify(e.message.usage ?? {}));
  }
});

console.error('model:', session.model?.id, 'provider:', session.model?.provider);
console.error('tools:', session.getActiveToolNames());

try {
  await session.prompt('Create a file named ember-test.txt containing exactly the word ember. Then confirm in one short sentence.');
} finally {
  console.log('\n--- tally ---');
  console.log('deltas:', events.filter(x => x === 'delta').length);
  console.log('tool starts:', events.filter(x => x.startsWith('tool:')).join(', ') || 'NONE');
  console.log('usage seen:', events.filter(x => x.startsWith('usage')).length ? 'yes' : 'no');
  session.dispose();
}
