import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("test-claude-bridge-reload", {
    description: "Test-only reload command",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
}
