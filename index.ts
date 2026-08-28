import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function extensionReloaderExtension(pi: ExtensionAPI) {
  let reloadRequested = false;

  pi.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, themes, and context files",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Reloading Pi runtime...", "info");
      await ctx.reload();
      return;
    },
  });

  pi.on("agent_settled", () => {
    if (!reloadRequested) return;
    reloadRequested = false;
    pi.sendUserMessage("/reload-runtime", {
      expandPromptTemplates: true,
    });
  });

  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Pi Runtime",
    description: "Reload extensions, skills, prompts, themes, and context files after editing them",
    promptSnippet: "Reload Pi resources after editing extensions, skills, prompts, themes, or context files",
    promptGuidelines: [
      "Call reload_runtime once after editing Pi resources so the current session uses the changes.",
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "Why the reload is needed" }),
    }),
    async execute(_toolCallId, params) {
      reloadRequested = true;
      return {
        content: [
          {
            type: "text",
            text: `Pi runtime reload will run after the current agent run settles: ${params.reason}`,
          },
        ],
        details: { command: "/reload-runtime", reason: params.reason },
        terminate: true,
      };
    },
  });
}
