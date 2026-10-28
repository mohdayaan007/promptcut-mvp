"use client";

import { useRef, useState } from "react";

export default function FounderTestPage() {
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const accessCodeRef = useRef(null);

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const accessCode = new FormData(event.currentTarget).get("accessCode");
      const response = await fetch("/api/founder-test-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessCode })
      });
      if (accessCodeRef.current) accessCodeRef.current.value = "";
      if (!response.ok) throw new Error("Founder test access was not granted.");
      window.location.assign("/");
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
        <form onSubmit={submit}>
          <label htmlFor="founder-access-code">Access code</label>
          <input ref={accessCodeRef} id="founder-access-code" name="accessCode" type="password" autoComplete="current-password" required />
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={submitting}>{submitting ? "Checking…" : "Continue to Cliponaut"}</button>
        </form>
      </section>
    </main>
  );
}
