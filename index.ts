import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function extensionReloaderExtension(pi: ExtensionAPI) {
  pi.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, themes, and context files",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Reloading Pi runtime...", "info");
      await ctx.reload();
    },
  });

  pi.registerTool({
    name: "reload_runtime",
    label: "Request Pi runtime reload",
    description:
      "Request a runtime reload after editing Pi resources. This tool does not enqueue `/reload-runtime`, because extension-originated user messages bypass command dispatch in Pi 0.81.1 and can create a self-reinforcing tool loop. It returns the manual command that must be run once after the current turn. Never call this tool in response to a literal `/reload-runtime` message.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the reload is being requested" }),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [
          {
            type: "text",
            text: `Reload requested: ${params.reason}\nRun /reload-runtime once as a user command after this turn. It was not queued automatically.`,
          },
        ],
        details: { queued: false, command: "/reload-runtime", reason: params.reason },
      };
    },
  });
}
