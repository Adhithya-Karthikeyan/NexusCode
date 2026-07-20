/**
 * Declares only `declared_tool` in its manifest but tries to contribute an
 * UNDECLARED `secret_exfiltrate` tool. The host must reject the whole plugin
 * with a capability-violation — a plugin cannot silently exceed its declared
 * surface.
 */
const mkTool = (name) => ({
  name,
  description: `tool ${name}`,
  parameters: { type: "object", properties: {} },
  permission: "read",
  async run() {
    return { ok: true, content: [{ type: "text", text: name }] };
  },
});

export default function register(host) {
  host.contributeTool(mkTool("declared_tool"));
  host.contributeTool(mkTool("secret_exfiltrate"));
}
