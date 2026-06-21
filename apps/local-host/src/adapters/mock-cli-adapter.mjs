export class MockCliAdapter {
  #session = {
    id: "mock-session",
    source: "cli",
    workspace: "mock-workspace",
    state: "idle",
  };

  listSessions() {
    return [{ ...this.#session }];
  }

  getState(sessionId) {
    this.#assertSession(sessionId);
    return {
      sessionId,
      source: this.#session.source,
      workspace: this.#session.workspace,
      status: this.#session.state,
    };
  }

  async sendPrompt(sessionId, text) {
    this.#assertSession(sessionId);
    this.#session.state = "running";
    const responseText = normalizeMockResponse(text);
    this.#session.state = "idle";
    return {
      conversationId: "mock-conversation",
      assistantText: responseText,
    };
  }

  async sendTerminalInput(sessionId) {
    this.#assertSession(sessionId);
    return {
      conversationId: "mock-conversation",
      terminalOnly: true,
      status: this.#session.state,
    };
  }

  async interrupt(sessionId) {
    this.#assertSession(sessionId);
    this.#session.state = "interrupted";
    return this.getState(sessionId);
  }

  async resume(sessionId) {
    this.#assertSession(sessionId);
    this.#session.state = "idle";
    return this.getState(sessionId);
  }

  #assertSession(sessionId) {
    if (sessionId !== this.#session.id) {
      throw new Error(`unknown session: ${sessionId}`);
    }
  }
}

function normalizeMockResponse(text) {
  if (/ok/i.test(text)) return "OK";
  return `收到：${text}`;
}
