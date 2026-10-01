export function JobRecoveryModal({ active, isResolving, error, onContinue, onStartFresh }) {
  const title = active ? "You have an edit in progress." : "Your edit is ready.";
  const description = active
    ? "What would you like to do?"
    : "View your finished edit or start a new one.";

  return (
    <div className="cliponaut-recovery-backdrop" role="presentation">
      <section className="cliponaut-recovery-modal" role="dialog" aria-modal="true" aria-labelledby="job-recovery-title">
        <p className="cliponaut-recovery-kicker">Previous edit</p>
        <h2 id="job-recovery-title">{title}</h2>
        <p>{description}</p>
        {error ? <p className="cliponaut-recovery-error" role="alert">{error}</p> : null}
        <div className="cliponaut-recovery-actions">
          <button type="button" className="cliponaut-recovery-primary" onClick={onContinue} disabled={isResolving}>
            {active ? "Continue" : "View edit"}
          </button>
          <button type="button" className="cliponaut-recovery-secondary" onClick={onStartFresh} disabled={isResolving}>
            {isResolving ? "Starting fresh…" : "Start fresh"}
          </button>
        </div>
      </section>
    </div>
  );
}
