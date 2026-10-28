/** Browser-side lifecycle guard for one Google Identity Services challenge. */
export function createGoogleSignInCoordinator({ fetchImpl, loadScript, initialize, render, onState, onCredential }) {
  let inFlight = null;
  let sequence = 0;

  async function start() {
    if (inFlight) return inFlight.promise;
    const id = ++sequence;
    onState({ phase: "loading", error: "" });
    const promise = (async () => {
      const response = await fetchImpl("/api/auth/google/nonce", { cache: "no-store" });
      if (!response.ok) throw new Error("challenge");
      const { nonce } = await response.json();
      if (typeof nonce !== "string" || !nonce) throw new Error("challenge");
      const google = await loadScript();
      if (!google?.accounts?.id) throw new Error("script");
      google.accounts.id.initialize({
        client_id: process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID,
        nonce,
        callback: async ({ credential }) => {
          try { await onCredential({ credential, nonce }); }
          catch { onState({ phase: "error", error: "Google sign-in could not be completed." }); }
        }
      });
      render(google);
      onState({ phase: "ready", error: "" });
    })();
    inFlight = { id, promise };
    try { await promise; }
    catch {
      if (inFlight?.id === id) onState({ phase: "error", error: "Google sign-in is temporarily unavailable." });
    } finally {
      if (inFlight?.id === id) inFlight = null;
    }
  }

  return { start, retry: start };
}

/** Loads GIS once; a failed script is removed so Retry can request a fresh copy. */
export function loadGoogleIdentityScript(documentRef = document, windowRef = window) {
  if (windowRef.google?.accounts?.id) return Promise.resolve(windowRef.google);
  const existing = documentRef.querySelector('script[data-cliponaut-gis="true"]');
  if (existing?.__cliponautPromise) return existing.__cliponautPromise;
  const script = documentRef.createElement("script");
  const promise = new Promise((resolve, reject) => {
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.dataset.cliponautGis = "true";
    script.onload = () => windowRef.google?.accounts?.id ? resolve(windowRef.google) : reject(new Error("GIS unavailable"));
    script.onerror = () => { script.remove(); reject(new Error("GIS failed to load")); };
    documentRef.head.appendChild(script);
  });
  script.__cliponautPromise = promise;
  return promise;
}
