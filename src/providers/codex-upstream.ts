const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

function buildHeaders(accessToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

export async function callCodexResponses(accessToken: string, body: unknown): Promise<Response> {
  return fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: buildHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

