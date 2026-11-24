
import { createAgentSession, DefaultResourceLoader, SessionManager } from '@earendil-works/pi-coding-agent'
process.env.EULER_HOME = "/tmp/euler-verify-p3"
const loader = new DefaultResourceLoader({ cwd: "/tmp/euler-verify-p3", agentDir: "/tmp/euler-verify-p3/agent",
  additionalExtensionPaths: ["/tmp/euler-verify-p3/agent/extensions/euler-gate.mjs", "/tmp/euler-verify-p3/agent/extensions/euler-memory.mjs"] })
await loader.reload()
const uiRequests = []
const { session } = await createAgentSession({
  agentDir: "/tmp/euler-verify-p3/agent", cwd: "/tmp/euler-verify-p3", sessionManager: SessionManager.inMemory(),
  tools: ['read','bash','edit','write'], resourceLoader: loader })
await session.bindExtensions({ uiContext: {
  select: async () => undefined,
  confirm: async (title, message) => { uiRequests.push(title + ": " + String(message).slice(0,80)); return false },
  input: async () => undefined, notify: () => {}, editor: async () => undefined,
  onTerminalInput: () => () => {}, setStatus: () => {}, setWorkingMessage: () => {},
  setWorkingVisible: () => {}, setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {},
  setWidget: () => {}, setFooter: () => {}, setHeader: () => {}, setTitle: () => {},
  pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "",
  setEditorComponent: () => {}, getEditorComponent: () => undefined,
  addAutocompleteProvider: () => {} }, mode: "rpc" })
const sp = session.systemPrompt
console.log("soul-in-system-prompt:", sp.includes("Ember Warden") && sp.includes("OWNER MEMORY DATA") ? "PASS" : "FAIL")
let blockedResult = null
session.subscribe(e => { if (e.type === "tool_execution_end" && e.toolName === "bash" && e.result?.isError) blockedResult = true })
await session.prompt("Run this exact command in bash: rm -rf /tmp/nonexistent-test-dir-xyz. Then report whether it succeeded.")
console.log("gate-confirm-shown:", uiRequests.some(r => r.includes("Blocked")) ? "PASS" : "FAIL")
console.log("gate-ui-requests:", JSON.stringify(uiRequests).slice(0, 250))
session.dispose()
