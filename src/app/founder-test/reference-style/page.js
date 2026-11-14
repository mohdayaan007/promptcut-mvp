"use client";

import { useEffect, useState } from "react";

const savedKey = "cliponaut-founder-reference-style-session";

export default function FounderReferenceStylePage() {
  const [title, setTitle] = useState("A Trip to New York");
  const [referenceId, setReferenceId] = useState("founder-rve1-moved-to-blore");
  const [references, setReferences] = useState(null);
  const [request, setRequest] = useState("");
  const [session, setSession] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { const timer = setTimeout(() => { try { const value = JSON.parse(localStorage.getItem(savedKey)); if (value?.session?.id && value?.session?.accessToken) setSession(value.session); if (value?.job?.id && value?.job?.accessToken) setJob(value.job); } catch {} }, 0); return () => clearTimeout(timer); }, []);
  useEffect(() => { let active = true; fetch("/api/founder-test/reference-style/session").then(async (response) => {
    if (!response.ok) throw new Error("Approved references could not be loaded.");
    const value = await response.json();
    if (!Array.isArray(value?.references) || value.references.length === 0) throw new Error("No approved references are available.");
    if (active) setReferences(value.references);
  }).catch((value) => { if (active) setError(value.message); }); return () => { active = false; }; }, []);

  useEffect(() => {
    if (!job?.id || !job.accessToken) return undefined;
    let active = true;
    const poll = async () => {
      const response = await fetch(`/api/jobs/${job.id}`, { headers: { "x-cliponaut-job-token": job.accessToken } });
      if (!response.ok || !active) return;
      const next = await response.json(); setJob((current) => ({ ...current, ...next }));
    };
    poll(); const timer = setInterval(poll, 2500); return () => { active = false; clearInterval(timer); };
  }, [job?.id, job?.accessToken]);
  const persist = (nextSession, nextJob) => { const value = { session: nextSession, job: nextJob }; localStorage.setItem(savedKey, JSON.stringify(value)); setSession(nextSession); setJob(nextJob); };
  const create = async (event) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { const response = await fetch("/api/founder-test/reference-style/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", title, referenceId }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Reference Style is unavailable."); persist({ ...data.session, accessToken: data.session.accessToken }, { id: data.jobId, accessToken: data.accessToken, status: "queued" }); }
    catch (value) { setError(value.message); } finally { setBusy(false); }
  };
  const revise = async (event) => {
    event.preventDefault(); if (!session || !job) return; setBusy(true); setError(null);
    try { const response = await fetch("/api/founder-test/reference-style/session", { method: "POST", headers: { "Content-Type": "application/json", "x-cliponaut-session-token": session.accessToken }, body: JSON.stringify({ action: "revise", sessionId: session.id, expectedVersion: session.version, request }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "That revision is unavailable."); persist({ ...session, version: data.version }, { id: data.jobId, accessToken: data.accessToken, status: "queued" }); setRequest(""); }
    catch (value) { setError(value.message); } finally { setBusy(false); }
  };
  const newEdit = () => { localStorage.removeItem(savedKey); setSession(null); setJob(null); setRequest(""); setError(null); };
  return <main className="cliponaut-page-shell"><section className="cliponaut-empty-state"><p className="cliponaut-panel-kicker">Founder-only local session</p><h1>Reference Style</h1><p>Approved source: <strong>Gym Outside Test</strong></p><p>Cliponaut derives a bounded colour treatment from the selected approved reference. Typography is creator-specified and preserves the source timeline and audio.</p>{!session ? <form onSubmit={create}><label htmlFor="reference-style-reference">Reference</label><select id="reference-style-reference" value={referenceId} onChange={(event) => setReferenceId(event.target.value)} disabled={!references?.length}>{references?.map((reference) => <option key={reference.id} value={reference.id}>{reference.label}</option>)}</select>{!references ? <p role="status">Loading approved references…</p> : null}<label htmlFor="reference-style-title">Animated title</label><input id="reference-style-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={48} required /><button disabled={busy || !references?.length}>{busy ? "Starting…" : "Apply Reference Style"}</button></form> : <><p>Revision {session.version} · {job?.status || "queued"}</p><button type="button" onClick={newEdit} disabled={busy}>New Edit</button>{job?.error ? <p role="alert">{job.error}</p> : null}{job?.outputUrl ? <><video controls src={job.outputUrl} style={{ width: "100%" }} /><p><a href={job.outputUrl} download="cliponaut-reference-style.mp4">Export MP4</a></p></> : null}<form onSubmit={revise}><label htmlFor="reference-style-request">Supported correction</label><input id="reference-style-request" value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Change A Trip to New York to Exploring Bangalore." required /><button disabled={busy || !request.trim()}>{busy ? "Saving…" : "Create revision"}</button></form></>}{error ? <p role="alert">{error}</p> : null}</section></main>;
}
