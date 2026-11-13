"use client";

import { useRef, useState } from "react";

export default function FounderTestPage() {
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const accessCodeRef = useRef(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const accessCode = accessCodeRef.current?.value || "";
      const response = await fetch("/api/founder-test-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessCode })
      });
      if (accessCodeRef.current) accessCodeRef.current.value = "";
      if (!response.ok) throw new Error("Founder test access was not granted.");
      window.location.assign(process.env.NEXT_PUBLIC_FOUNDER_REFERENCE_STYLE_LOCAL_MODE === "true" ? "/founder-test/reference-style" : "/");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="cliponaut-page-shell">
      <section className="cliponaut-empty-state" aria-labelledby="founder-test-heading">
        <p className="cliponaut-panel-kicker">Controlled test access</p>
        <h1 id="founder-test-heading">Founder-only conversational editing</h1>
        <p>This temporary access enables the Phase 4 test flow for this browser only.</p>
        <div>
          <label htmlFor="founder-access-code">Access code</label>
          <input ref={accessCodeRef} id="founder-access-code" type="password" autoComplete="current-password" required />
          {error && <p role="alert">{error}</p>}
          <button type="button" onClick={submit} disabled={submitting}>{submitting ? "Checking…" : "Continue to Cliponaut"}</button>
        </div>
      </section>
    </main>
  );
}
