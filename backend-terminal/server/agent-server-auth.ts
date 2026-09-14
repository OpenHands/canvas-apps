const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function normalizeAgentServerUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TERMINAL_AGENT_SERVER_URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("TERMINAL_AGENT_SERVER_URL must be a bare origin without credentials.");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("TERMINAL_AGENT_SERVER_URL must resolve through an explicit loopback hostname.");
  }
  return url.origin;
}

export async function validateAgentServerKey(
  agentServerUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<boolean> {
  if (apiKey.length < 8 || apiKey.length > 4096) return false;

  try {
    const response = await fetch(new URL("/api/conversations/search?limit=1", agentServerUrl), {
      headers: { "X-Session-API-Key": apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}
