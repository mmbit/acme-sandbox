// One message of Claude Code's stream, as a CLI's events() gives it: text, a tool call or a tool's result
type StreamRole = 'assistant' | 'user';
export const streamMessage = (role: StreamRole, session: unknown, content: object[]) => ({
  type: role,
  session_id: session,
  parent_tool_use_id: null,
  message: { role, content },
});
