/** Helpers for mid-turn user steering via OpenCode prompt_async. */

export type OpencodeSessionMessage = {
  info?: { id?: string; role?: string };
  parts?: Array<{
    type?: string;
    text?: string;
    state?: { status?: string };
  }>;
};

export function normalizeSteeringContent(content: string): string {
  return content.trim();
}

export function midTurnSteeringKey(id: string | undefined, content: string): string {
  const norm = normalizeSteeringContent(content);
  return id?.trim() || `content:${norm}`;
}

export function extractUserMessageText(msg: OpencodeSessionMessage): string {
  return (msg.parts || [])
    .filter((p) => p.type === "text" && p.text?.trim())
    .map((p) => p.text!.trim())
    .join("\n");
}

/** True when an assistant message after the matching user text has substantive output. */
export function userMessageHasAssistantReply(
  messages: OpencodeSessionMessage[],
  userContent: string,
): boolean {
  const normalizedTarget = normalizeSteeringContent(userContent);
  if (!normalizedTarget) return true;

  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = (messages[i]?.info?.role || "").toLowerCase();
    if (role !== "user") continue;
    const text = normalizeSteeringContent(extractUserMessageText(messages[i]!));
    if (text === normalizedTarget) {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return false;

  for (let i = userIdx + 1; i < messages.length; i++) {
    const role = (messages[i]?.info?.role || "").toLowerCase();
    if (role !== "assistant") continue;
    const hasText = (messages[i]?.parts || []).some(
      (p) => (p.type === "text" || p.type === "reasoning") && p.text?.trim(),
    );
    const hasCompletedTool = (messages[i]?.parts || []).some(
      (p) => p.type === "tool" && p.state?.status === "completed",
    );
    if (hasText || hasCompletedTool) return true;
  }
  return false;
}

export async function fetchOpencodeSessionMessages(
  attachUrl: string,
  opencodeSessionId: string,
  cwd = process.cwd(),
): Promise<OpencodeSessionMessage[]> {
  const base = attachUrl.replace(/\/$/, "");
  const url = `${base}/session/${encodeURIComponent(opencodeSessionId)}/message`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "x-opencode-directory": cwd },
  });
  if (!res.ok) {
    throw new Error(`OpenCode session messages HTTP ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as OpencodeSessionMessage[]) : [];
}

/**
 * After a turn ends, re-queue mid-turn steering messages that prompt_async accepted
 * but OpenCode never answered (e.g. blocked on long-running bash).
 */
export async function releaseUnansweredMidTurnMessages(
  attachUrl: string,
  opencodeSessionId: string,
  midTurnInjected: Map<string, string>,
  queue: string[],
  wake: () => void,
  sidecarAnsweredKeys: Set<string> = new Set(),
): Promise<void> {
  if (!midTurnInjected.size) return;

  let messages: OpencodeSessionMessage[] = [];
  try {
    messages = await fetchOpencodeSessionMessages(attachUrl, opencodeSessionId);
  } catch (err: unknown) {
    console.error(
      `ChimpHands mid-turn steering check failed — queueing unanswered injected messages: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    for (const [key, content] of midTurnInjected.entries()) {
      if (sidecarAnsweredKeys.has(key)) continue;
      queue.push(content);
    }
    midTurnInjected.clear();
    wake();
    return;
  }

  for (const [key, content] of midTurnInjected.entries()) {
    if (sidecarAnsweredKeys.has(key)) {
      console.error(
        `ChimpHands mid-turn steering message ${key} answered by sidecar — no re-queue`,
      );
      continue;
    }
    if (userMessageHasAssistantReply(messages, content)) {
      console.error(
        `ChimpHands mid-turn steering message ${key} was answered in-session — no re-queue`,
      );
      continue;
    }
    console.error(
      `ChimpHands mid-turn steering message ${key} unanswered — queueing for next turn`,
    );
    queue.push(content);
  }
  midTurnInjected.clear();
  if (queue.length) wake();
}
