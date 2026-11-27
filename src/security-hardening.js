const encoder = new TextEncoder();

export function isValidEmail(value) {
  const email = String(value ?? "").trim();
  if (!email || email.length > 254) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@")) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !domain || domain.length > 253) return false;
  if (/\s/.test(email) || !domain.includes(".")) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return domain.split(".").every(label =>
    label.length > 0 && label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  );
}

export function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left ?? ""));
  const b = encoder.encode(String(right ?? ""));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    difference |= (a[i % (a.length || 1)] || 0) ^ (b[i % (b.length || 1)] || 0);
  }
  return difference === 0;
}

export async function readJsonLimited(request, maxBytes = 8192) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error("Request body too large");
    error.code = "BODY_TOO_LARGE";
    throw error;
  }

  if (!request.body) throw new SyntaxError("Empty JSON body");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        const error = new Error("Request body too large");
        error.code = "BODY_TOO_LARGE";
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}
