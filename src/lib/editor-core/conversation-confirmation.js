import crypto from "crypto";

const MAX_AGE_MS = 10 * 60 * 1000;

function encode(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decode(value) {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { return null; }
}
function signature(payload, secret) { return crypto.createHmac("sha256", secret).update(payload).digest("base64url"); }

export function createConversationConfirmation({ session, expectedVersion, baseJobId, supportedPrompt, message, now = Date.now() }) {
  const payload = encode({ sessionId: session.id, expectedVersion, baseJobId, supportedPrompt, exp: now + MAX_AGE_MS });
  return { token: `${payload}.${signature(payload, session.access_token)}`, message };
}

export function verifyConversationConfirmation({ session, token, expectedVersion, baseJobId, now = Date.now() }) {
  if (typeof token !== "string") return null;
  const [payload, provided] = token.split(".");
  if (!payload || !provided) return null;
  const expected = signature(payload, session.access_token);
  const valid = provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!valid) return null;
  const action = decode(payload);
  if (!action || action.sessionId !== session.id || action.expectedVersion !== expectedVersion || action.baseJobId !== baseJobId || action.exp < now || typeof action.supportedPrompt !== "string") return null;
  return action;
}
