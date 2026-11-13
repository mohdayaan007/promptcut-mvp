export default async function FounderTestPage({ searchParams }) {
  const failed = (await searchParams)?.error === "access";
  return (
    <main className="cliponaut-page-shell">
      <section className="cliponaut-empty-state" aria-labelledby="founder-test-heading">
        <p className="cliponaut-panel-kicker">Controlled test access</p>
        <h1 id="founder-test-heading">Founder-only conversational editing</h1>
        <p>This temporary access enables the local Reference Style workflow for this browser only.</p>
        <form method="post" action="/api/founder-test-access">
          <label htmlFor="founder-access-code">Access code</label>
          <input id="founder-access-code" name="accessCode" type="password" autoComplete="current-password" required />
          {failed ? <p role="alert">Founder test access was not granted.</p> : null}
          <button type="submit">Continue to Cliponaut</button>
        </form>
      </section>
    </main>
  );
}
