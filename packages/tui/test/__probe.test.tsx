import { render } from "ink-testing-library";
import { Box } from "ink";
import { describe, it } from "vitest";
import { CapabilityProvider, ThemeProvider } from "../src/index.js";
import { Markdown } from "../src/components/Markdown.js";
import { CodeBlock } from "../src/components/CodeBlock.js";
import { MessageView } from "../src/render/MessageView.js";
import { PaneFrame } from "../src/layout/PaneFrame.js";

const caps = { truecolor: true, colors256: true, unicode: true, noColor: false, isTTY: true, width: 40, height: 24 };
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const CODE = `const token = randomBytes(32).toString("base64url");`;

function show(label: string, node: React.ReactNode): void {
  const { lastFrame } = render(
    <CapabilityProvider caps={caps}>
      <ThemeProvider>{node}</ThemeProvider>
    </CapabilityProvider>,
  );
  const lines = strip(lastFrame() ?? "").split("\n");
  console.log(`\n--- ${label} ---`);
  lines.forEach((l) => console.log(`[${String(l.length).padStart(2)}] ${l}`));
}

describe("probe", () => {
  it("isolates the code-block wrap", () => {
    show("CodeBlock w=29 bare", <CodeBlock code={CODE} lang="ts" width={29} showLineNumbers={false} />);
    show("CodeBlock w=29 in Box width=31", (
      <Box width={31}>
        <CodeBlock code={CODE} lang="ts" width={29} showLineNumbers={false} />
      </Box>
    ));
    show("Markdown width=31", <Markdown content={"```ts\n" + CODE + "\n```\n"} width={31} />);
    show("Markdown width=31 in Box", (
      <Box width={31} flexDirection="column">
        <Markdown content={"```ts\n" + CODE + "\n```\n"} width={31} />
      </Box>
    ));

    const turn = {
      id: "t", lane: "main", text: "Intro line.\n\n```ts\n" + CODE + "\n```\n",
      reasoning: "", tools: [], diffs: [], finished: true, startedTs: 0,
    };
    show("MessageView width=34", <MessageView turn={turn as never} provider="anthropic" width={34} />);
    show("MessageView width=34 in PaneFrame width=38 height=12 (fits)", (
      <PaneFrame title="Conversation" width={38} height={12}>
        <MessageView turn={turn as never} provider="anthropic" width={34} />
      </PaneFrame>
    ));
    show("MessageView width=34 in PaneFrame width=38 height=5 (CLIPPED)", (
      <PaneFrame title="Conversation" width={38} height={5}>
        <MessageView turn={turn as never} provider="anthropic" width={34} />
      </PaneFrame>
    ));
  });
});
