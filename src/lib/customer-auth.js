import crypto from "crypto";

export const CUSTOMER_SESSION_COOKIE = "cliponaut_customer";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

export class CustomerAuthError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

export function normalizeCustomerEmail(value) {
  const email = typeof value === "string" ? value.trim() : "";
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CustomerAuthError("Enter a valid email address.");
  return email.toLowerCase();
}

function authSecret() {
  const value = process.env.CUSTOMER_AUTH_TOKEN_SECRET || "";
  if (value.length < 32) throw new CustomerAuthError("Customer sign-in is temporarily unavailable.", 503);
  return value;
}

export function hashCustomerToken(token) { return crypto.createHmac("sha256", authSecret()).update(token).digest("hex"); }
export function newCustomerToken() { return crypto.randomBytes(32).toString("base64url"); }
export function sessionCookie(token) { return `${CUSTOMER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`; }
export function clearCustomerSession() { return `${CUSTOMER_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`; }
export function customerSessionToken(req) {
  const entry = (req.headers.get("cookie") || "").split(/;\s*/).find((part) => part.startsWith(`${CUSTOMER_SESSION_COOKIE}=`));
  return entry ? entry.slice(CUSTOMER_SESSION_COOKIE.length + 1) : "";
}

/** Email is intentionally unavailable until the founder configures one server-side provider. */
export async function sendVerificationEmail({ email, token, fetchImpl = fetch }) {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.CUSTOMER_AUTH_EMAIL_FROM || "";
  const appUrl = process.env.CUSTOMER_AUTH_APP_URL || "";
  if (!apiKey || !from || !appUrl) throw new CustomerAuthError("Email sign-in is not configured yet.", 503);
  let verifyUrl;
  try { verifyUrl = new URL("/api/auth/verify", appUrl); } catch { throw new CustomerAuthError("Email sign-in is not configured yet.", 503); }
  verifyUrl.searchParams.set("token", token);
  verifyUrl.searchParams.set("email", email);
  const response = await fetchImpl("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [email], subject: "Sign in to Cliponaut", text: `Use this secure, single-use Cliponaut sign-in link within 15 minutes: ${verifyUrl}` }) });
  if (!response.ok) throw new CustomerAuthError("Email sign-in is temporarily unavailable.", 503);
}
