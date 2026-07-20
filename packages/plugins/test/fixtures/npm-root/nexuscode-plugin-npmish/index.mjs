/**
 * An npm-convention fixture plugin discovered from a `node_modules` directory by
 * its `nexuscode-plugin-*` name. Uses the DECLARATIVE contract: a named
 * `contributes` export (no imperative register function). It adds a prompt, an
 * MCP server config, and a TUI panel, each matching a declared id in its
 * package.json `nexuscode.contributes` block.
 */
export const contributes = {
  prompts: [{ id: "npmish.summary", version: "1.0.0", body: "Summarize: {{text}}" }],
  mcpServers: [
    {
      name: "npmish-mcp",
      transport: "stdio",
      enabled: true,
      trustAnnotations: false,
      command: "npmish-mcp-server",
      args: [],
      env: {},
    },
  ],
  uiPanels: [{ id: "npmish.panel", title: "Npmish Panel", placement: "sidebar" }],
};
