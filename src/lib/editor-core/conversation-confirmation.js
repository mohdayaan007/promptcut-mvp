import crypto from "crypto";

const MAX_AGE_MS = 10 * 60 * 1000;

export class ConfirmationConfigurationError extends Error {}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decode(value) {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { return null; }
}
function signature(payload, secret) { return crypto.createHmac("sha256", secret).update(payload).digest("base64url"); }
function signingSecret(secret) {
  const value = secret || process.env.EDITING_CONFIRMATION_SECRET;
  if (typeof value !== "string" || value.length < 32) {
    throw new ConfirmationConfigurationError("EDITING_CONFIRMATION_SECRET is not configured");
  }
  return value;
}

export function createConversationConfirmation({ session, expectedVersion, baseJobId, supportedPrompt, message, now = Date.now(), secret }) {
  const payload = encode({ sessionId: session.id, expectedVersion, baseJobId, supportedPrompt, message, exp: now + MAX_AGE_MS });
  return { token: `${payload}.${signature(payload, signingSecret(secret))}`, message };
}

export function verifyConversationConfirmation({ session, token, expectedVersion, baseJobId, now = Date.now(), secret }) {
  if (typeof token !== "string") return null;
  const [payload, provided] = token.split(".");
  if (!payload || !provided) return null;
  const expected = signature(payload, signingSecret(secret));
  const valid = provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!valid) return null;
  const action = decode(payload);
  if (!action || action.sessionId !== session.id || action.exp < now || typeof action.supportedPrompt !== "string" || typeof action.message !== "string") return null;
  if (expectedVersion !== undefined && action.expectedVersion !== expectedVersion) return null;
  if (baseJobId !== undefined && action.baseJobId !== baseJobId) return null;
  return action;
}
