import crypto from "crypto";

export const FOUNDER_TEST_COOKIE = "cliponaut_founder_test";
const MAX_COOKIE_AGE_SECONDS = 60 * 60;
const MIN_SECRET_LENGTH = 32;

function config() {
  const secret = process.env.FOUNDER_TEST_ACCESS_SECRET || "";
  const enabled = process.env.FOUNDER_CONVERSATIONAL_EDITING_ENABLED === "true";
  return { enabled: enabled && secret.length >= MIN_SECRET_LENGTH, secret };
}

function signature(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function equal(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(request) {
  const source = request.headers.get("cookie") || "";
  const entry = source.split(/;\s*/).find((part) => part.startsWith(`${FOUNDER_TEST_COOKIE}=`));
  return entry ? entry.slice(FOUNDER_TEST_COOKIE.length + 1) : "";
}

export function isFounderTestEnabled() {
  return config().enabled;
}

export function hasFounderTestAccess(request, now = Date.now()) {
  const { enabled, secret } = config();
  if (!enabled) return false;
  const value = cookieValue(request);
  const [expiresAt, nonce, received] = value.split(".");
  if (!/^\d{13}$/.test(expiresAt) || !/^[A-Za-z0-9_-]{16,}$/.test(nonce) || !received || Number(expiresAt) <= now) return false;
  return equal(received, signature(`${expiresAt}.${nonce}`, secret));
}

export function grantFounderTestAccess(accessCode, now = Date.now()) {
  const { enabled, secret } = config();
  if (!enabled || typeof accessCode !== "string" || !equal(accessCode, secret)) return null;
  const expiresAt = now + MAX_COOKIE_AGE_SECONDS * 1000;
  const nonce = crypto.randomBytes(24).toString("base64url");
  const value = `${expiresAt}.${nonce}`;
  return `${FOUNDER_TEST_COOKIE}=${value}.${signature(value, secret)}; Path=/; Max-Age=${MAX_COOKIE_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearFounderTestAccess() {
  return `${FOUNDER_TEST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
