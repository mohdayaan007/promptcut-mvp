# Google-only customer sign-in

Create a Google Cloud OAuth 2.0 Web application client. Add the deployed Cliponaut origin and approved local development origin to Authorized JavaScript origins. Set its client ID in GOOGLE_OAUTH_CLIENT_ID and NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID; the client ID is public, while CUSTOMER_AUTH_TOKEN_SECRET must be a random server-only value of at least 32 characters.

No client secret is used by this Google Identity Services ID-token flow. The server verifies every credential with Google's maintained google-auth-library, including signature, issuer, audience, expiry, verified email, stable sub, and a server-issued single-use nonce. Google identities are permanently keyed by sub; email is display and reconciliation metadata only.

Google authentication is deliberately separate from payment-email ownership. An active Cliponaut subscription may be automatically reconciled only for a verified `@gmail.com` address or a Google Workspace address whose server-verified `hd` claim exactly matches its email domain. A verified external-domain Google address still signs in, but cannot claim a Dodo subscription by email matching. This policy is stored with the identity, defaults existing records to fail-closed `unknown`, and applies to both login-time and webhook-time reconciliation. Stage 2B should bind checkout directly to the authenticated identity instead.

Public checkout, entitlement enforcement, quotas, and Live Mode remain disabled.
