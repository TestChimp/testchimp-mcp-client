/** Parallel OpenCode child-session turn for mid-turn steering Q&A. */

export type OpencodeModelRef = {
  providerID: string;
  modelID: string;
};

export function parseOpencodeModelRef(model: string): OpencodeModelRef | undefined {
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

export function buildSteeringSidecarPrompt(userQuestion: string, conversationSummary: string): string {
  const summary = conversationSummary.trim();
  const parts = [
    "Mid-turn steering reply — the main ChimpHands session is still running a long command in parallel.",
    "Answer the user's question directly and concisely.",
    "Do NOT run bash/shell, edit files, or kick off long tools. Read-only lookup is OK if needed.",
    "Do not repeat the full plan; focus on the question.",
  ];
  if (summary) {
    parts.push("", "Conversation so far:", summary);
  }
  parts.push("", "User question:", userQuestion.trim());
  return parts.join("\n");
}

type OpencodeMessagePart = {
  type?: string;
  text?: string;
  state?: { status?: string; output?: string };
};

type OpencodeMessageResponse = {
  info?: { role?: string; id?: string };
  parts?: OpencodeMessagePart[];
};

export function extractAssistantReplyParts(response: OpencodeMessageResponse): string[] {
  const role = (response.info?.role || "").toLowerCase();
  if (role && role !== "assistant") return [];
  const out: string[] = [];
  for (const part of response.parts || []) {
    if (part.type === "text" && part.text?.trim()) {
      out.push(part.text.trim());
    }
  }
  return out;
}

export type SteeringSidecarOptions = {
  attachUrl: string;
  parentSessionId: string;
  userQuestion: string;
  conversationSummary?: string;
  model: string;
  agentId: string;
  cwd?: string;
  /** Max wait for the child-session /message round-trip. */
  timeoutMs?: number;
};

async function opencodeFetch(
  attachUrl: string,
  path: string,
  init: RequestInit,
  cwd: string,
): Promise<Response> {
  const base = attachUrl.replace(/\/$/, "");
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-opencode-directory": cwd,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function createSteeringChildSession(
  attachUrl: string,
  parentSessionId: string,
  cwd: string,
): Promise<string> {
  const res = await opencodeFetch(
    attachUrl,
    "/session",
    {
      method: "POST",
      body: JSON.stringify({
        parentID: parentSessionId,
        title: "ChimpHands steering",
      }),
    },
    cwd,
  );
  if (!res.ok) {
    throw new Error(`OpenCode create steering session HTTP ${res.status}`);
  }
  const data = (await res.json()) as { id?: string };
  const childId = data.id?.trim();
  if (!childId) throw new Error("OpenCode create steering session returned no id");
  return childId;
}

/**
 * Run a parallel OpenCode turn on a child session so the user gets an immediate
 * answer while the main session stays blocked on a long-running tool.
 */
export async function runSteeringSidecarReply(opts: SteeringSidecarOptions): Promise<string[]> {
  const cwd = opts.cwd || process.cwd();
  const childSessionId = await createSteeringChildSession(opts.attachUrl, opts.parentSessionId, cwd);
  const modelRef = parseOpencodeModelRef(opts.model);
  const prompt = buildSteeringSidecarPrompt(opts.userQuestion, opts.conversationSummary || "");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = {
      agent: opts.agentId,
      noReply: false,
      parts: [{ type: "text", text: prompt }],
    };
    if (modelRef) body.model = modelRef;

    const res = await opencodeFetch(
      opts.attachUrl,
      `/session/${encodeURIComponent(childSessionId)}/message`,
      {
        method: "POST",
        body: JSON.stringify(body),
        signal: ac.signal,
      },
      cwd,
    );
    if (!res.ok) {
      throw new Error(`OpenCode steering /message HTTP ${res.status}`);
    }
    const data = (await res.json()) as OpencodeMessageResponse;
    return extractAssistantReplyParts(data);
  } finally {
    clearTimeout(timer);
  }
}
