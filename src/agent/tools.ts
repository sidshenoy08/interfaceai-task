// Tool definitions for the discovery agent loop. Each tool is a primitive
// the LLM can invoke; the loop executes it against the live page and turns
// the primitive + its resolved locator into a Step for the artifact.
//
// Deliberate omission: `click` does not ask the model to self-report a risk
// level. Risk is derived deterministically by the policy engine from the
// action's visible text (see guardrails/policy.ts) so a model that
// under-reports risk cannot bypass the confirmation gate.
import type OpenAI from "openai";

export const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "declare_capability",
      description:
        "Call this exactly once, as your first action, before doing anything else. Declares the reusable capability you are about to record: its id, name, description, typed inputs the caller will supply, typed outputs you will extract, and its overall risk level.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "stable kebab-case id, e.g. lookup-member-balance" },
          name: { type: "string" },
          description: { type: "string" },
          riskLevel: { type: "string", enum: ["read-only", "reversible-write", "irreversible-write"] },
          inputs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string", enum: ["string", "number", "boolean"] },
                description: { type: "string" },
                sensitive: { type: "boolean" },
              },
              required: ["name", "type"],
            },
          },
          outputs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string", enum: ["string", "number", "boolean"] },
                description: { type: "string" },
              },
              required: ["name", "type"],
            },
          },
        },
        required: ["id", "name", "description", "riskLevel", "inputs", "outputs"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate the browser to an absolute URL within the allowed origin.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "Click an element observed in the current snapshot, identified by its ref (e.g. 'e3').",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          intent: {
            type: "string",
            description: "Plain-language description of what this click does, e.g. 'Confirm and open account'.",
          },
        },
        required: ["ref", "intent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description:
        "Type text into an input/textarea observed in the current snapshot. If the value should come from a caller-supplied parameter at replay time (e.g. a member id), set paramName to the matching input name you declared in declare_capability instead of hardcoding it.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          text: { type: "string" },
          paramName: { type: "string" },
        },
        required: ["ref", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select",
      description: "Choose an option in a <select> observed in the current snapshot.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          value: { type: "string" },
          paramName: { type: "string" },
        },
        required: ["ref", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_text",
      description: "Read the visible text/value of an observed element and record it as one of your declared outputs.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string" },
          outputName: { type: "string" },
        },
        required: ["ref", "outputName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_intent",
      description:
        "Explicitly confirm you intend to perform an irreversible action before clicking it. The intent text must match the intent you will pass to the subsequent click exactly.",
      parameters: {
        type: "object",
        properties: { intent: { type: "string" } },
        required: ["intent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assert_checkpoint",
      description:
        "Record a checkpoint: a condition that proves you actually reached the state you expected. Call this right after any step whose success you want replay to verify (in particular, right before finishing).",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string" },
          kind: { type: "string", enum: ["urlContains", "textPresent", "textAbsent"] },
          value: { type: "string" },
        },
        required: ["description", "kind", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Call when the goal has been fully accomplished (or you have conclusively determined it cannot be).",
      parameters: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          summary: { type: "string" },
        },
        required: ["success", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate",
      description:
        "Call when you cannot safely proceed: you are blocked by policy repeatedly, you don't understand the current state, or you've hit an error you can't resolve. This pauses you and brings in a human operator.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
];
