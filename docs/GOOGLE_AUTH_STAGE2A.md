# Google-only customer sign-in

Create a Google Cloud OAuth 2.0 Web application client. Add the deployed Cliponaut origin and approved local development origin to Authorized JavaScript origins. Set its client ID in GOOGLE_OAUTH_CLIENT_ID and NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID; the client ID is public, while CUSTOMER_AUTH_TOKEN_SECRET must be a random server-only value of at least 32 characters.

No client secret is used by this Google Identity Services ID-token flow. The server verifies every credential with Google's maintained google-auth-library, including signature, issuer, audience, expiry, verified email, stable sub, and a server-issued single-use nonce. Google identities are permanently keyed by sub; email is display and reconciliation metadata only.

Public checkout, entitlement enforcement, quotas, and Live Mode remain disabled.
