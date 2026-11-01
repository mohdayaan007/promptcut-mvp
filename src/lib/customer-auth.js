import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";

export const CUSTOMER_SESSION_COOKIE = "cliponaut_customer";
export const GOOGLE_NONCE_COOKIE = "cliponaut_google_nonce";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

export class CustomerAuthError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

function authSecret() {
  const value = process.env.CUSTOMER_AUTH_TOKEN_SECRET || "";
  if (value.length < 32) throw new CustomerAuthError("Customer sign-in is temporarily unavailable.", 503);
  return value;
}
export function hashCustomerToken(token) { return crypto.createHmac("sha256", authSecret()).update(token).digest("hex"); }
export function newCustomerToken() { return crypto.randomBytes(32).toString("base64url"); }
export function sessionCookie(token) { return `${CUSTOMER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`; }
export function clearCustomerSession() { return `${CUSTOMER_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`; }
export function nonceCookie(token) { return `${GOOGLE_NONCE_COOKIE}=${token}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`; }
export function clearGoogleNonce() { return `${GOOGLE_NONCE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`; }
function cookie(req, name) { const entry = (req.headers.get("cookie") || "").split(/;\s*/).find((part) => part.startsWith(`${name}=`)); return entry ? entry.slice(name.length + 1) : ""; }
export function customerSessionToken(req) { return cookie(req, CUSTOMER_SESSION_COOKIE); }
export function googleNonceToken(req) { return cookie(req, GOOGLE_NONCE_COOKIE); }

/**
 * Google authenticates the account identified by `sub`.  It is only also
 * authoritative for the mailbox when Google says the address is Gmail, or
 * when its Workspace hosted-domain claim agrees with the address domain.
 */
export function googleEmailAuthority(payload) {
  const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
  const domain = email.split("@")[1] || "";
  if (domain === "gmail.com") return { authority: "gmail", hostedDomain: null };
  const hostedDomain = typeof payload?.hd === "string" ? payload.hd.trim().toLowerCase() : "";
  if (hostedDomain && hostedDomain === domain) return { authority: "workspace", hostedDomain };
  return { authority: "external", hostedDomain: null };
}

export async function verifyGoogleCredential(credential, nonce, { clientId = process.env.GOOGLE_OAUTH_CLIENT_ID, client = new OAuth2Client() } = {}) {
  if (!clientId || typeof credential !== "string" || credential.length > 16_000 || !nonce) throw new CustomerAuthError("Google sign-in is temporarily unavailable.", 503);
  let ticket;
  try { ticket = await client.verifyIdToken({ idToken: credential, audience: clientId }); } catch { throw new CustomerAuthError("Google sign-in could not be verified.", 401); }
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || payload.email_verified !== true || payload.nonce !== nonce) throw new CustomerAuthError("Google sign-in could not be verified.", 401);
  return { subject: payload.sub, email: payload.email.trim().toLowerCase(), ...googleEmailAuthority(payload) };
}
