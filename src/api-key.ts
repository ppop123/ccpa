export function extractApiKey(
  headers: { authorization?: string; "x-api-key"?: string | string[] }
): string {
  const auth = headers.authorization;
  const bearer = auth?.match(/^\s*Bearer\s+(.+?)\s*$/i);
  if (bearer?.[1]) {
    return bearer[1].trim();
  }

  const xApiKey = headers["x-api-key"];
  if (typeof xApiKey === "string") {
    return xApiKey;
  }
  if (Array.isArray(xApiKey) && xApiKey.length > 0) {
    return xApiKey[0];
  }

  return "";
}
