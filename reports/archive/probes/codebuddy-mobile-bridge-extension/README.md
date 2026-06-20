# CodeBuddy Mobile Bridge Probe

This is a minimal VS Code-compatible extension used to test whether CodeBuddy IDE can load a third-party extension and whether that extension can call CodeBuddy/Genie commands.

It binds an HTTP probe server to `127.0.0.1:17321` by default.

Endpoints:

- `GET /health`: confirms extension activation.
- `GET /probe`: lists candidate CodeBuddy commands visible to the extension host and attempts to execute selected commands.

Candidate commands include:

- `tencentcloud.codingcopilot.getWebviewInfo`
- `tencentcloud.codingcopilot.chat.startNewChat`
- `tencentcloud.codingcopilot.addToChat`
- `tencentcloud.codingcopilot.clearSession`
- `workbench.action.forceResolveWebviewView`
- `workbench.action.openCodeBuddyWebview`
- `workbench.view.extension.coding-copilot-chat`

Manual runtime test:

```sh
/Users/robiluo/.codebuddy/bin/buddy \
  --extensionDevelopmentPath "$PWD/reports/archive/probes/codebuddy-mobile-bridge-extension" \
  "$PWD"
```

Then run:

```sh
curl http://127.0.0.1:17321/health
curl http://127.0.0.1:17321/probe
```

Expected interpretation:

- If `/health` responds, CodeBuddy can load the extension.
- If `/probe` shows Genie commands as visible, a third-party bridge can discover CodeBuddy commands.
- If command execution succeeds for message/session commands, a phone controller can potentially drive the existing IDE session through an extension bridge.
- If only view/open commands work, the bridge can observe/open UI but not truly continue the session without CodeBuddy product support or an official local API.
