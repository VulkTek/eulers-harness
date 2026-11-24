
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory() });
console.log('resolved:', session.model?.id, '| provider:', session.model?.provider);
