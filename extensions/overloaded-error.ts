/**
 * Intercepts Anthropic overloaded_error responses and shows a friendly
 * explanation in the UI instead of the raw JSON error string.
 *
 * The error surfaces as an assistant message with:
 *   stopReason: "error"
 *   errorMessage: '{"type":"error","error":{"type":"overloaded_error",...}}'
 *
 * pi will automatically retry with exponential back-off. This extension just
 * makes sure the user knows *why* things are paused.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;

    // Only care about assistant messages that ended in an error
    if (msg.role !== "assistant" || msg.stopReason !== "error" || !msg.errorMessage) return;

    // Check for overloaded_error (either as JSON or plain text)
    const isOverloaded = msg.errorMessage.includes("overloaded_error") ||
      /overloaded/i.test(msg.errorMessage);

    if (!isOverloaded) return;

    ctx.ui.notify(
      "Anthropic servers are overloaded — pi will retry automatically. " +
      "You can press Escape to cancel the retry.",
      "warning"
    );
  });
}
