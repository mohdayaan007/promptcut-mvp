import Link from "next/link";

export function EditorAccessNotice({ state, onRetry }) {
  if (!state?.title) return null;
  return <aside className={`cliponaut-editor-access is-${state.tone}`} role={state.tone === "error" ? "alert" : "status"}><div><strong>{state.title}</strong>{state.detail ? <p>{state.detail}</p> : null}</div>{state.href ? <Link href={state.href}>{state.href === "/pricing" ? "View pricing" : "Open account"}</Link> : null}{state.action === "retry" ? <button type="button" onClick={onRetry}>Retry</button> : null}</aside>;
}
