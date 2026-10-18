import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PENDING_CONTINUATION = "pi-extension-reloader.pending-continuation";
const DISPATCHED_CONTINUATION = "pi-extension-reloader.dispatched-continuation";
const MAX_REASON_LENGTH = 500;
const MAX_CONTINUATION_LENGTH = 4_000;
const BRIDGE_PROPERTY = "__piExtensionReloaderContinuationBridge";

type ReloadRequest = {
  reason: string;
  continueWith: string;
};

type ReloadState = {
  resume?: () => void;
};

type GlobalWithContinuationBridge = typeof globalThis & {
  __piExtensionReloaderContinuationBridge?: Map<string, ReloadState>;
};

function reloadStates(): Map<string, ReloadState> {
  const scope = globalThis as GlobalWithContinuationBridge;
  scope[BRIDGE_PROPERTY] ??= new Map();
  return scope[BRIDGE_PROPERTY];
}

function normalizeReloadRequest(value: unknown): ReloadRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const request = value as Partial<ReloadRequest>;
  if (typeof request.reason !== "string" || typeof request.continueWith !== "string") {
    return undefined;
  }

  const reason = request.reason.trim();
  const continueWith = request.continueWith.trim();
  if (
    !reason ||
    reason.length > MAX_REASON_LENGTH ||
    !continueWith ||
    continueWith.length > MAX_CONTINUATION_LENGTH
  ) {
    return undefined;
  }
  return { reason, continueWith };
}

function continuationPrompt(request: ReloadRequest): string {
  // Model-authored fields are fenced so they read as data, not as control text.
  return [
    "Automatic continuation after Pi runtime reload.",
    "Reload reason (model-supplied):",
    '"""',
    request.reason,
    '"""',
    "Continue the original user request from where it stopped. Later user messages take precedence for the remaining work; the reload itself is already complete.",
    "Do not call reload_runtime again for the same edits.",
    "Remaining work (model-supplied):",
    '"""',
    request.continueWith,
    '"""',
  ].join("\n");
}

// Structural loop guard: the prompt instruction not to reload the same edits is
// reinforced by rejecting an exact repeat of the last dispatched continuation.
function isRepeatOfLastDispatched(ctx: ExtensionContext, request: ReloadRequest): boolean {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "custom") continue;
    // A newer pending entry means a reload is already scheduled in this run;
    // duplicate coalescing below handles that case.
    if (entry.customType === PENDING_CONTINUATION) return false;
    if (entry.customType !== DISPATCHED_CONTINUATION) continue;
    const dispatched = normalizeReloadRequest(entry.data);
    return dispatched?.reason === request.reason && dispatched?.continueWith === request.continueWith;
  }
  return false;
}

export default function extensionReloaderExtension(pi: ExtensionAPI) {
  let reloadRequest: ReloadRequest | undefined;

  pi.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, themes, and context files",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const states = reloadStates();
      if (states.has(sessionId)) {
        ctx.ui.notify("Pi runtime reload already in progress.", "info");
        return;
      }

      const state: ReloadState = {};
      states.set(sessionId, state);
      try {
        await ctx.waitForIdle();
        ctx.ui.notify("Reloading Pi runtime...", "info");
        await ctx.reload();
      } catch (error) {
        if (states.get(sessionId) === state) states.delete(sessionId);
        throw error;
      }

      // ctx.reload() finishes in this old command frame. The callback itself was
      // installed by the fresh extension instance and uses only its fresh Pi API.
      // If the reloaded extension failed to load, no callback was installed; the
      // persisted pending continuation is recovered by a later /reload-runtime.
      const resume = state.resume;
      if (states.get(sessionId) === state) states.delete(sessionId);
      resume?.();
      return;
    },
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "reload") return;

    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type !== "custom") continue;
      if (entry.customType === DISPATCHED_CONTINUATION) return;
      if (entry.customType !== PENDING_CONTINUATION) continue;
      const request = normalizeReloadRequest(entry.data);
      if (!request) return;

      const sessionId = ctx.sessionManager.getSessionId();
      const state = reloadStates().get(sessionId);
      if (!state) return;
      state.resume = () => {
        pi.appendEntry(DISPATCHED_CONTINUATION, request);
        // Another extension may have started a notification turn during reload.
        // Use Pi's existing queue instead of dropping this already-marked dispatch.
        pi.sendUserMessage(continuationPrompt(request), { deliverAs: "followUp" });
      };
      return;
    }
  });

  pi.on("agent_settled", () => {
    if (!reloadRequest) return;

    const toolSource = pi.getAllTools().find((tool) => tool.name === "reload_runtime")?.sourceInfo;
    const reloadCommand = pi.getCommands().find(
      (command) =>
        command.source === "extension" &&
        command.sourceInfo.path === toolSource?.path &&
        (command.name === "reload-runtime" || command.name.startsWith("reload-runtime:")),
    );
    if (!reloadCommand) {
      // Surfaces as an extension_error; reloadRequest stays set so the next
      // settlement retries resolution instead of dropping the pending reload.
      throw new Error("Could not resolve this extension's reload-runtime command");
    }

    reloadRequest = undefined;
    pi.sendUserMessage(`/${reloadCommand.name}`, {
      expandPromptTemplates: true,
    });
  });

  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Pi Runtime",
    description:
      "Reload Pi extensions, skills, prompts, themes, and context files, then automatically continue the task in a fresh agent turn. Examples: use after editing an extension before calling its changed tool; after changing a skill or prompt before using it; or after changing a theme or context file before verifying it. Do not use for ordinary application source changes.",
    promptSnippet:
      "Reload edited Pi runtime resources, then continue the remaining work automatically",
    promptGuidelines: [
      "After all Pi runtime-resource edits finish, call reload_runtime in a separate tool batch with no sibling tool calls; call it again only after additional runtime-resource edits.",
      "Set reload_runtime continueWith to the exact work remaining after reload.",
    ],
    parameters: Type.Object({
      reason: Type.String({
        minLength: 1,
        maxLength: MAX_REASON_LENGTH,
        description: "Why the reload is needed",
      }),
      continueWith: Type.String({
        minLength: 1,
        maxLength: MAX_CONTINUATION_LENGTH,
        description:
          "Exact task to perform automatically after reload, for example: Call hello_world and report its output",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const request = normalizeReloadRequest(params);
      if (!request) {
        throw new Error(
          `reason and continueWith must contain non-whitespace text within ${MAX_REASON_LENGTH} and ${MAX_CONTINUATION_LENGTH} characters`,
        );
      }
      if (ctx && isRepeatOfLastDispatched(ctx, request)) {
        throw new Error(
          "This exact reload already ran and its continuation was dispatched. Continue the remaining work instead of calling reload_runtime again for the same edits.",
        );
      }
      const scheduled = reloadRequest;
      if (!scheduled) {
        pi.appendEntry(PENDING_CONTINUATION, request);
        reloadRequest = request;
      }
      const active = scheduled ?? request;

      return {
        content: [
          {
            type: "text",
            text: scheduled
              ? `A Pi runtime reload is already scheduled from an earlier call in this run; this duplicate call was ignored. The scheduled reload will run after the current agent run settles, then continue automatically with: ${active.continueWith}`
              : `Pi runtime reload will run after the current agent run settles, then continue automatically with: ${active.continueWith}`,
          },
        ],
        details: {
          command: "/reload-runtime",
          reason: active.reason,
          continueWith: active.continueWith,
        },
        terminate: true,
      };
    },
  });
}
