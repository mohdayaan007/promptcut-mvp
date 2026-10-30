"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AppHeader } from "@/components/cliponaut/AppHeader";
import { EmptyEditorState } from "@/components/cliponaut/EmptyEditorState";
import { EditorAccessNotice } from "@/components/cliponaut/EditorAccessNotice";
import { PromptComposer } from "@/components/cliponaut/PromptComposer";
import { PromptSuggestions } from "@/components/cliponaut/PromptSuggestions";
import { Workspace } from "@/components/cliponaut/Workspace";
import { JobRecoveryModal } from "@/components/cliponaut/JobRecoveryModal";
import { recordConversationCompletion } from "@/lib/client/conversation-presentation";
import {
  cancelJob,
  clearTerminalJob,
  clearUndoState,
  consumeUndo,
  describeUndoRestoration,
  discardUndoActiveJob,
  emptyUndoState,
  getInitialUndoAnchor,
  getJobStatus,
  isActiveJobStatus,
  isCurrentPresentationAttempt,
  isRecoverableJobStatus,
  loadUndoState,
  loadEditingSession,
  getEditingSessionHistory,
  promoteSuccessfulJob,
  recordTerminalJob,
  resolveUndoRestoration,
  saveUndoState,
  saveEditingSession,
  clearEditingSession,
  clearPendingPartialEdit,
  loadPendingPartialEdit,
  savePendingPartialEdit,
  setUndoActiveJob,
  submitConversationTurn,
  preflightEditingCapabilities,
  terminalAttemptPresentation,
  terminalAttemptMessage,
  terminalAttemptConversation,
  hasWorkspacePresentation,
  sourcesForTerminalAttempt,
  shouldScheduleUndoOriginalReveal,
  undoPreviewMode,
  uploadAndQueueJob,
  undoMediaReadyAction,
  waitForBrowserPaint,
} from "@/lib/client/direct-upload";
import { browserVideoPreflightError } from "@/lib/client/media-preflight";
import { editorAccessState } from "@/lib/editor-access-presentation";

const MAX_VIDEO_COUNT = 5;

function undoAnchorForCurrent(current, { consumed = false } = {}) {
  if (current?.kind !== "job") return null;
  return { jobId: current.session.id, prompt: current.prompt, consumed };
}

function getBrowserVideoMetadata(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const finish = (metadata) => {
      URL.revokeObjectURL(url);
      resolve(metadata);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => finish({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
    video.onerror = () => finish(null);
    video.src = url;
  });
}

function is4kCapable(metadata) {
  return metadata && Math.min(metadata.width, metadata.height) >= 2160 && Math.max(metadata.width, metadata.height) >= 3840;
}

export default function HomePage() {
  const [videos, setVideos] = useState([]);
  const [videoMetadata, setVideoMetadata] = useState([]);
  const [exportQuality, setExportQuality] = useState("standard");
  const [referenceImage, setReferenceImage] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  const [messages, setMessages] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [activeJob, setActiveJob] = useState(null);
  const [undoState, setUndoState] = useState(null);
  const [restoredSources, setRestoredSources] = useState([]);
  const [recovery, setRecovery] = useState(null);
  const [isResolvingRecovery, setIsResolvingRecovery] = useState(false);
  const [recoveryError, setRecoveryError] = useState(null);
  const [isUndoing, setIsUndoing] = useState(false);
  const [isRestoringPrevious, setIsRestoringPrevious] = useState(false);
  const [restoringOriginal, setRestoringOriginal] = useState(false);
  const [originalPreviewArmed, setOriginalPreviewArmed] = useState(false);
  const [restoringResultUrl, setRestoringResultUrl] = useState(null);
  const [undoAnchor, setUndoAnchor] = useState(null);
  const [editingSession, setEditingSession] = useState(null);
  const [pendingPartialEdit, setPendingPartialEdit] = useState(null);
  const [editorAccess, setEditorAccess] = useState({ phase: "loading" });

  const videoInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const promptRef = useRef(null);
  const requestControllerRef = useRef(null);
  const undoStateRef = useRef(null);
  const originalRevealScheduledRef = useRef(false);
  const turnIdRef = useRef(0);
  const presentationAttemptRef = useRef(0);
  // Keep terminal handling stable while retaining the latest completed preview.
  const resultUrlRef = useRef(null);

  useEffect(() => {
    resultUrlRef.current = resultUrl;
  }, [resultUrl]);

  const hasWorkspace = hasWorkspacePresentation({ videos, referenceImage, activeJob, undoState });
  const canExport4k = videos.length > 0 && videoMetadata.length === videos.length && videoMetadata.every(is4kCapable);
  const isProcessing = isActiveJobStatus(status);
  const previewMode = undoPreviewMode({ isRestoring: isRestoringPrevious, current: undoState?.current, localVideoCount: videos.length });
  const accessState = editorAccessState(editorAccess);
  const canStartNewRender = !accessState.blocking;

  const refreshEditorAccess = useCallback(async () => {
    setEditorAccess((current) => ({ ...current, phase: "loading" }));
    try {
      const response = await fetch("/api/editor-access");
      if (!response.ok) throw new Error("Editor access is unavailable");
      setEditorAccess({ phase: "ready", ...await response.json() });
    } catch { setEditorAccess((current) => ({ ...current, phase: "error" })); }
  }, []);

  useEffect(() => { refreshEditorAccess(); }, [refreshEditorAccess]);

  const persistUndoState = useCallback((nextState) => {
    const saved = saveUndoState(nextState);
    undoStateRef.current = saved;
    setUndoState(saved);
    if (saved.current?.kind === "job" && saved.previous) setUndoAnchor(undoAnchorForCurrent(saved.current));
    return saved;
  }, []);

  const showOriginal = useCallback((sources) => {
    resultUrlRef.current = null;
    setActiveJob(null);
    setRestoredSources(sources || []);
    setStatus("idle");
    setResultUrl(null);
    setError(null);
  }, []);

  const showCompletedJob = useCallback((session, job) => {
    resultUrlRef.current = job.outputUrl;
    setActiveJob(session);
    setRestoredSources(job.sources || []);
    setStatus("done");
    setResultUrl(job.outputUrl);
    setError(null);
  }, []);

  const showTerminalAttempt = useCallback((job) => {
    const presentation = terminalAttemptPresentation(job, resultUrlRef.current);
    setActiveJob(null);
    setRestoredSources((current) => sourcesForTerminalAttempt(job, current));
    setStatus(presentation.status);
    setResultUrl(presentation.resultUrl);
    setError(presentation.error);
    setUploadProgress(null);
  }, []);

  const beginPresentationAttempt = useCallback(({ keepResult = false } = {}) => {
    const nextAttempt = presentationAttemptRef.current + 1;
    presentationAttemptRef.current = nextAttempt;
    // Successful history remains in Undo state, but cannot be displayed as the
    // current output while a new attempt is uploading or processing.
    if (!keepResult) {
      setActiveJob(null);
      setRestoredSources([]);
      setResultUrl(null);
    }
    setIsUndoing(false);
    setIsRestoringPrevious(false);
    setRestoringOriginal(false);
    setOriginalPreviewArmed(false);
    if (!keepResult) setRestoringResultUrl(null);
    return nextAttempt;
  }, []);

  const finishUndoRestoration = useCallback(() => {
    originalRevealScheduledRef.current = false;
    setIsRestoringPrevious(false);
    setIsUndoing(false);
    setRestoringOriginal(false);
    setOriginalPreviewArmed(false);
    setRestoringResultUrl(null);
  }, []);

  const restoreCurrentVersion = useCallback(async (current, attempt = presentationAttemptRef.current) => {
    if (!current) {
      if (!isCurrentPresentationAttempt(attempt, presentationAttemptRef.current)) return false;
      setActiveJob(null);
      setRestoredSources([]);
      setStatus("idle");
      setResultUrl(null);
      return true;
    }
    if (current.kind === "original") {
      if (!isCurrentPresentationAttempt(attempt, presentationAttemptRef.current)) return false;
      showOriginal(current.sources);
      return true;
    }
    try {
      const job = await getJobStatus(current.session);
      if (job.status !== "completed" || !job.outputUrl) throw new Error("The previous version is no longer available.");
      if (!isCurrentPresentationAttempt(attempt, presentationAttemptRef.current)) return false;
      showCompletedJob(current.session, job);
      return true;
    } catch {
      return false;
    }
  }, [showCompletedJob, showOriginal]);

  useEffect(() => {
    const hydrationAttempt = presentationAttemptRef.current;
    const saved = loadUndoState();
    const savedSession = loadEditingSession();
    setEditingSession(savedSession);
    const savedPending = loadPendingPartialEdit();
    if (savedPending?.sessionId !== savedSession?.id) clearPendingPartialEdit();
    undoStateRef.current = saved;
    setUndoState(saved);
    setUndoAnchor(getInitialUndoAnchor(saved));
    let stopped = false;
    if (saved.terminal) {
      showTerminalAttempt(saved.terminal);
      setMessages(terminalAttemptConversation(saved.terminal));
    }
    if (!saved.active?.id || !saved.active?.accessToken) {
      if (saved.current) restoreCurrentVersion(saved.current, hydrationAttempt).then(() => {
        if (!stopped && saved.terminal && isCurrentPresentationAttempt(hydrationAttempt, presentationAttemptRef.current)) showTerminalAttempt(saved.terminal);
      });
    }
    if (savedSession) {
      getEditingSessionHistory(savedSession, undefined, savedPending?.sessionId === savedSession.id ? savedPending.token : undefined).then((sessionHistory) => {
        if (stopped || !isCurrentPresentationAttempt(hydrationAttempt, presentationAttemptRef.current)) return;
        setEditingSession(saveEditingSession({ ...savedSession, version: sessionHistory.latestVersion }));
        let hasPreviousSuccessfulEdit = false;
        const restoredMessages = sessionHistory.history.flatMap((entry) => {
          const turns = [{ role: "user", text: entry.prompt, jobId: entry.jobId }];
          if (entry.status === "completed") {
            turns.push({ role: "assistant", text: entry.confirmation || "Your edit is ready.", jobId: entry.jobId });
            hasPreviousSuccessfulEdit = true;
          } else if (["failed", "cancelled"].includes(entry.status)) {
            turns.push({ role: "assistant", text: terminalAttemptMessage(entry, hasPreviousSuccessfulEdit), jobId: entry.jobId });
          }
          return turns;
        });
        if (sessionHistory.pendingConfirmation) {
          const pending = { sessionId: savedSession.id, ...sessionHistory.pendingConfirmation };
          savePendingPartialEdit(pending);
          setPendingPartialEdit(pending);
          restoredMessages.push({ role: "assistant", text: sessionHistory.pendingConfirmation.message, pending: true });
        } else if (savedPending?.sessionId === savedSession.id) {
          clearPendingPartialEdit();
          setPendingPartialEdit(null);
        }
        setMessages(restoredMessages);
      }).catch(() => {});
    }
    const discover = async () => {
      try {
        const job = await getJobStatus(saved.active);
        if (stopped || !isCurrentPresentationAttempt(hydrationAttempt, presentationAttemptRef.current)) return;
        if (job.status === "completed" && job.outputUrl) {
          const next = persistUndoState(promoteSuccessfulJob(saved, saved.active, job.sources));
          setRecovery({ session: next.current.session, job });
        } else if (isRecoverableJobStatus(job.status)) {
          setRecovery({ session: saved.active, job });
        } else {
          persistUndoState(recordTerminalJob(saved, saved.active, job));
          showTerminalAttempt(job);
        }
      } catch {
        if (!stopped && isCurrentPresentationAttempt(hydrationAttempt, presentationAttemptRef.current)) {
          setActiveJob(saved.active);
          setStatus("error");
          // A transient status lookup failure must not discard the completed
          // preview retained while a follow-up was in progress.
          setError("We couldn’t check that edit. Please try again.");
        }
      }
    };
    if (saved.active?.id && saved.active?.accessToken) discover();
    return () => { stopped = true; };
  }, [persistUndoState, restoreCurrentVersion, showTerminalAttempt]);

  useEffect(() => {
    if (!activeJob || !isActiveJobStatus(status)) return undefined;
    let stopped = false;
    const pollingAttempt = presentationAttemptRef.current;
    const pollingSession = activeJob;
    let checking = false;
    const check = async () => {
      if (stopped || checking) return;
      checking = true;
      try {
        const job = await getJobStatus(pollingSession);
        if (stopped || !isCurrentPresentationAttempt(pollingAttempt, presentationAttemptRef.current)) return;
        setRestoredSources(job.sources || []);
        setStatus(job.status === "completed" ? "done" : job.status);
        if (job.status === "completed") {
          if (job.outputUrl) {
            const next = persistUndoState(promoteSuccessfulJob(undoStateRef.current || emptyUndoState(), pollingSession, job.sources));
            setUndoAnchor(undoAnchorForCurrent(next.current));
            showCompletedJob(next.current.session, job);
            setMessages((current) => recordConversationCompletion(current, pollingSession.id, job.confirmation));
          } else {
            persistUndoState(recordTerminalJob(undoStateRef.current || emptyUndoState(), pollingSession, { ...job, status: "failed", error: "We couldn’t retrieve that edit." }));
            showTerminalAttempt({ ...job, status: "failed", error: "We couldn’t retrieve that edit." });
            setMessages((current) => [...current, { role: "assistant", text: terminalAttemptMessage({ status: "failed", error: "We couldn’t retrieve that edit." }, Boolean(undoStateRef.current?.current)) }]);
          }
        } else if (["failed", "cancelled"].includes(job.status)) {
          persistUndoState(recordTerminalJob(undoStateRef.current || emptyUndoState(), pollingSession, job));
          showTerminalAttempt(job);
          setMessages((current) => [...current, { role: "assistant", text: terminalAttemptMessage(job, Boolean(undoStateRef.current?.current)) }]);
        }
        if (["completed", "failed", "cancelled"].includes(job.status)) refreshEditorAccess();
      } catch (statusError) {
        if (!stopped && isCurrentPresentationAttempt(pollingAttempt, presentationAttemptRef.current)) setError(statusError.message);
      } finally {
        checking = false;
      }
    };
    check();
    const timer = setInterval(check, 3_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [activeJob, persistUndoState, refreshEditorAccess, showCompletedJob, showTerminalAttempt, status]);

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  const generateResponseText = (value) => {
    const lowerCasePrompt = value.toLowerCase();
    const responses = [];

    if (lowerCasePrompt.includes("cinematic")) responses.push("Cinematic colour grading added.");
    if (lowerCasePrompt.includes("warm")) responses.push("Warm colour grading added.");
    if (lowerCasePrompt.includes("blue") || lowerCasePrompt.includes("cool")) {
      responses.push("Cool colour grading added.");
    }
    if (lowerCasePrompt.includes("black and white") || lowerCasePrompt.includes("bw")) {
      responses.push("Black & white grading added.");
    }
    if (lowerCasePrompt.includes("add title") || lowerCasePrompt.includes("show title")) responses.push("Title added.");

    const trimMatch = lowerCasePrompt.match(/from\s*(\d+:\d+)\s*to\s*(\d+:\d+)/);
    if (trimMatch) responses.push(`Video trimmed from ${trimMatch[1]} to ${trimMatch[2]}.`);
    if (videos.length > 1 || lowerCasePrompt.includes("merge")) responses.push("Videos merged.");

    return responses.length ? responses.join(" ") : "Your edit is ready.";
  };

  const handleVideosChange = async (event) => {
    if (!canStartNewRender) { setError(accessState.detail || "Editing access is unavailable."); event.target.value = ""; return; }
    const addedVideos = Array.from(event.target.files || []);
    event.target.value = "";
    if (!addedVideos.length) return;

    const acceptedVideos = addedVideos.slice(0, Math.max(0, MAX_VIDEO_COUNT - videos.length));
    if (!acceptedVideos.length) {
      setError(`You can upload up to ${MAX_VIDEO_COUNT} videos at a time.`);
      return;
    }
    if (addedVideos.length > acceptedVideos.length) setError(`Only the first ${MAX_VIDEO_COUNT} videos can be added.`);
    const metadata = await Promise.all(acceptedVideos.map(getBrowserVideoMetadata));
    const preflightError = metadata.map(browserVideoPreflightError).find(Boolean);
    if (preflightError) {
      setError(preflightError);
      return;
    }
    setVideos((currentVideos) => [...currentVideos, ...acceptedVideos]);
    setVideoMetadata((currentMetadata) => [...currentMetadata, ...metadata]);
  };

  const handleImagesChange = (event) => {
    if (!canStartNewRender) { setError(accessState.detail || "Editing access is unavailable."); event.target.value = ""; return; }
    const image = event.target.files?.[0];
    if (!image) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type)) {
      setError("Style references must be JPG, PNG, or WebP images.");
      event.target.value = "";
      return;
    }
    setReferenceImage(image);
    event.target.value = "";
  };

  const handleRemoveVideo = (index) => {
    setVideos((currentVideos) => currentVideos.filter((_, videoIndex) => videoIndex !== index));
    setVideoMetadata((currentMetadata) => currentMetadata.filter((_, videoIndex) => videoIndex !== index));
    if (videos.length <= 1) setExportQuality("standard");
  };

  const handleGenerate = async () => {
    if ((!videos.length && !editingSession) || !prompt.trim() || isProcessing) return;
    if (!canStartNewRender) { setError(accessState.detail || "Editing access is unavailable."); return; }

    let submittedPrompt = prompt;
    const confirmation = /^(?:yes|yes\s*,?\s*proceed|proceed|continue|go ahead|okay|ok)$/i.test(submittedPrompt.trim());
    const cancellation = /^(?:no|cancel|don't|do not|stop)$/i.test(submittedPrompt.trim());
    if (pendingPartialEdit) {
      if (cancellation) {
        setPendingPartialEdit(null);
        clearPendingPartialEdit();
        setPrompt("");
        setMessages((current) => [...current, { role: "user", text: submittedPrompt }, { role: "assistant", text: "Okay — I haven’t changed your video." }]);
        return;
      }
      if (confirmation) {
        // Session actions are server-signed and version-bound. Initial-upload
        // actions are intentionally kept only in memory because no durable
        // server session exists yet.
        if (!pendingPartialEdit.token) submittedPrompt = pendingPartialEdit.supportedPrompt;
        setPendingPartialEdit(null);
        clearPendingPartialEdit();
      } else {
        // A new instruction supersedes the pending subset; it is never queued
        // accidentally after the user changes direction.
        setPendingPartialEdit(null);
        clearPendingPartialEdit();
      }
    }
    const retainingPreview = Boolean(editingSession && undoStateRef.current?.current?.kind === "job" && resultUrl);
    const presentationAttempt = beginPresentationAttempt({ keepResult: retainingPreview });
    const turnId = `turn-${Date.now()}-${++turnIdRef.current}`;
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setMessages((currentMessages) => [
      ...currentMessages,
      { role: "user", text: submittedPrompt, turnId },
    ]);
    setStatus("uploading");
    setError(null);

    try {
      if (editingSession && undoStateRef.current?.current?.kind === "job") {
        const turn = await submitConversationTurn(editingSession, submittedPrompt, controller.signal, undoStateRef.current.current.session.id, confirmation ? pendingPartialEdit?.token : undefined);
        if (controller.signal.aborted || !isCurrentPresentationAttempt(presentationAttempt, presentationAttemptRef.current)) return;
        if (turn.pendingConfirmation) {
          const pending = savePendingPartialEdit({ ...turn.pendingConfirmation, sessionId: editingSession.id });
          setPendingPartialEdit(pending || turn.pendingConfirmation);
          setStatus("done");
          setPrompt("");
          setMessages((currentMessages) => [...currentMessages, { role: "assistant", text: turn.pendingConfirmation.message }]);
          return;
        }
        const nextSession = saveEditingSession(turn.session);
        setEditingSession(nextSession);
        setMessages((currentMessages) => currentMessages.map((message) => message.turnId === turnId ? { ...message, jobId: turn.job.id } : message));
        persistUndoState(setUndoActiveJob(undoStateRef.current || emptyUndoState(), turn.job, submittedPrompt));
        setActiveJob(turn.job);
        setStatus("queued");
        setPrompt("");
        refreshEditorAccess();
        return;
      }
      const capability = await preflightEditingCapabilities(submittedPrompt, controller.signal);
      if (capability.kind === "partial") {
        setPendingPartialEdit(capability);
        setStatus("idle");
        setPrompt("");
        setMessages((currentMessages) => [...currentMessages, { role: "assistant", text: capability.message }]);
        return;
      }
      if (capability.kind === "unsupported" || capability.kind === "ambiguous") throw new Error(capability.message);
      const job = await uploadAndQueueJob({
        videos, referenceImage, prompt: submittedPrompt, exportQuality, signal: controller.signal,
        onProgress: setUploadProgress,
        onSession: (session) => {
          if (!isCurrentPresentationAttempt(presentationAttempt, presentationAttemptRef.current)) return;
          persistUndoState(setUndoActiveJob(undoStateRef.current || emptyUndoState(), session, submittedPrompt));
          setMessages((currentMessages) => currentMessages.map((message) => message.turnId === turnId ? { ...message, jobId: session.id } : message));
          setActiveJob(session);
          history.replaceState(null, "", `/?job=${session.id}`);
        }
      });
      if (controller.signal.aborted || !isCurrentPresentationAttempt(presentationAttempt, presentationAttemptRef.current)) return;
      if (job.session) {
        const nextSession = saveEditingSession(job.session);
        setEditingSession(nextSession);
      }
      if (["failed", "cancelled"].includes(job.status)) {
          persistUndoState(recordTerminalJob(undoStateRef.current || emptyUndoState(), undoStateRef.current?.active, job));
        showTerminalAttempt(job);
        setMessages((currentMessages) => [...currentMessages, { role: "assistant", text: terminalAttemptMessage(job, Boolean(undoStateRef.current?.current)) }]);
        return;
      }
      setStatus(job.status);
      setUploadProgress(null);
      setPrompt("");
      refreshEditorAccess();
    } catch (processingError) {
      if (controller.signal.aborted || !isCurrentPresentationAttempt(presentationAttempt, presentationAttemptRef.current)) return;
      if ([401, 403, 429].includes(processingError?.status)) refreshEditorAccess();
      persistUndoState(discardUndoActiveJob(undoStateRef.current || emptyUndoState()));
      showTerminalAttempt({ status: "failed", error: processingError.message });
      setMessages((currentMessages) => [...currentMessages, { role: "assistant", text: terminalAttemptMessage({ status: "failed" }, Boolean(undoStateRef.current?.current)) }]);
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    }
  };

  const handleEditAgain = () => {
    setResultUrl(null);
    setStatus("idle");
    setError(null);
    promptRef.current?.focus();
  };

  const handleViewPreviousEdit = async () => {
    const current = undoStateRef.current?.current;
    if (status !== "error" || current?.kind !== "job") return;
    const attempt = presentationAttemptRef.current;
    const restored = await restoreCurrentVersion(current, attempt);
    if (!isCurrentPresentationAttempt(attempt, presentationAttemptRef.current)) return;
    if (restored) {
      persistUndoState(clearTerminalJob(undoStateRef.current || emptyUndoState()));
      setMessages((messages) => [...messages, { role: "assistant", text: "Restored your previous successful edit." }]);
    } else {
      setError("The previous version is no longer available.");
    }
  };

  const resetWorkspace = () => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setVideos([]);
    setVideoMetadata([]);
    setExportQuality("standard");
    setReferenceImage(null);
    setPrompt("");
    setStatus("idle");
    setError(null);
    setResultUrl(null);
    setMessages([]);
    setUploadProgress(null);
    setActiveJob(null);
    setRestoredSources([]);
    setRecovery(null);
    setRecoveryError(null);
    setIsResolvingRecovery(false);
    setUndoAnchor(null);
    undoStateRef.current = null;
    setUndoState(null);
    clearUndoState();
    clearEditingSession();
    setEditingSession(null);
    setPendingPartialEdit(null);
    clearPendingPartialEdit();
    history.replaceState(null, "", window.location.pathname);
    if (videoInputRef.current) videoInputRef.current.value = "";
    if (imageInputRef.current) imageInputRef.current.value = "";
  };

  const handleBackToEmptyState = async () => {
    const active = undoStateRef.current?.active;
    if (!active || !isActiveJobStatus(status)) {
      resetWorkspace();
      return;
    }
    try {
      await cancelJob(active);
      resetWorkspace();
    } catch (cancelError) {
      setError(cancelError.message || "We couldn’t cancel that edit. Please try again.");
    }
  };

  const restoreJob = async (session, job) => {
    const attempt = presentationAttemptRef.current;
    const current = undoStateRef.current?.current;
    if (job.status === "completed" && job.outputUrl) showCompletedJob(session, job);
    else {
      let retainedUrl = null;
      if (editingSession && current?.kind === "job") {
        try {
          const previous = await getJobStatus(current.session);
          if (previous.status === "completed") retainedUrl = previous.outputUrl || null;
        } catch { /* Recovery of the active job remains available if its prior output expired. */ }
      }
      if (!isCurrentPresentationAttempt(attempt, presentationAttemptRef.current)) return;
      setActiveJob(session);
      setRestoredSources(job.sources || []);
      setStatus(job.status);
      setResultUrl(retainedUrl);
    }
    if (current?.kind === "job" && undoStateRef.current?.previous) setUndoAnchor(undoAnchorForCurrent(current));
    setRecovery(null);
    setRecoveryError(null);
  };

  const handleRecoveryStartFresh = async () => {
    if (!recovery || isResolvingRecovery) return;
    setIsResolvingRecovery(true);
    setRecoveryError(null);
    try {
      if (isActiveJobStatus(recovery.job.status)) await cancelJob(recovery.session);
      resetWorkspace();
    } catch (cancelError) {
      setRecoveryError(cancelError.message || "We couldn’t cancel that edit. Please try again.");
      setIsResolvingRecovery(false);
    }
  };

  const handleUndo = async () => {
    const previous = undoStateRef.current?.previous;
    if (!previous || isUndoing) return;
    const current = undoStateRef.current?.current;
    const restorationAttempt = presentationAttemptRef.current;
    // Commit the opaque restoring state before either an in-memory or network
    // restoration path can replace the current preview.
    flushSync(() => {
      setIsUndoing(true);
      setIsRestoringPrevious(true);
      setRestoringOriginal(previous.kind === "original");
      setOriginalPreviewArmed(false);
      setRestoringResultUrl(null);
      originalRevealScheduledRef.current = false;
    });
    await waitForBrowserPaint();
    if (!isCurrentPresentationAttempt(restorationAttempt, presentationAttemptRef.current)) return;

    if (previous.kind === "original") {
      // The source preview is intentionally mounted only after the opaque
      // restoring presentation has received a browser paint.
      setOriginalPreviewArmed(true);
      const next = persistUndoState(consumeUndo(undoStateRef.current));
      setUndoAnchor(undoAnchorForCurrent(current, { consumed: true }));
      showOriginal(next.current.sources);
      setMessages((messages) => [...messages, { role: "assistant", text: describeUndoRestoration({ current, previous }) }]);
      if (videos.length !== 1) finishUndoRestoration();
      return;
    }
    let waitingForMedia = false;
    try {
      const job = await getJobStatus(previous.session);
      if (!isCurrentPresentationAttempt(restorationAttempt, presentationAttemptRef.current)) return;
      const resolution = resolveUndoRestoration(undoStateRef.current, job);
      if (resolution.outcome === "restored") {
        const next = persistUndoState(resolution.state);
        setUndoAnchor(undoAnchorForCurrent(current, { consumed: true }));
        showCompletedJob(next.current.session, job);
        setRestoringResultUrl(job.outputUrl);
        setMessages((messages) => [...messages, { role: "assistant", text: describeUndoRestoration({ current, previous }) }]);
        waitingForMedia = true;
      } else if (resolution.outcome === "unavailable") {
        persistUndoState(resolution.state);
        setUndoAnchor(undoAnchorForCurrent(current, { consumed: true }));
        setMessages((messages) => [...messages, { role: "assistant", text: "The previous version is no longer available." }]);
      } else {
        setMessages((messages) => [...messages, { role: "assistant", text: "Couldn’t restore the previous version. Please try again." }]);
      }
    } catch {
      setMessages((messages) => [...messages, { role: "assistant", text: "Couldn’t restore the previous version. Please try again." }]);
    } finally {
      if (!waitingForMedia && isCurrentPresentationAttempt(restorationAttempt, presentationAttemptRef.current)) finishUndoRestoration();
    }
  };

  const handleRestoredMediaReady = useCallback(() => {
    const action = undoMediaReadyAction({
      isRestoring: isRestoringPrevious,
      restoringOriginal,
      originalPreviewArmed
    });
    if (action === "complete") {
      finishUndoRestoration();
    } else if (shouldScheduleUndoOriginalReveal({
      isRestoring: isRestoringPrevious,
      restoringOriginal,
      originalPreviewArmed
    }, originalRevealScheduledRef.current)) {
      originalRevealScheduledRef.current = true;
      // Keep the ready local Blob beneath the opaque cover for one more paint.
      // This prevents its synchronous loadeddata event from becoming the first
      // visible post-click state.
      waitForBrowserPaint().then(finishUndoRestoration);
    }
  }, [finishUndoRestoration, isRestoringPrevious, originalPreviewArmed, restoringOriginal]);

  return (
    <main className={`cliponaut-shell ${hasWorkspace ? "is-workspace" : "is-empty"}`}>
      <AppHeader />
      <EditorAccessNotice state={accessState} onRetry={refreshEditorAccess} />

      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        multiple
        className="cliponaut-visually-hidden"
        disabled={accessState.blocking}
        onChange={handleVideosChange}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="cliponaut-visually-hidden"
        disabled={accessState.blocking}
        onChange={handleImagesChange}
      />

      {hasWorkspace ? (
        <section className="cliponaut-workspace" aria-label="Video editing workspace">
          <Workspace
            videos={videos}
            restoredSources={restoredSources}
            referenceImage={referenceImage}
            status={status}
            uploadProgress={uploadProgress}
            error={error}
            resultUrl={resultUrl}
            messages={messages}
            exportQuality={exportQuality}
            canExport4k={canExport4k}
            onExportQualityChange={setExportQuality}
            onSelectVideos={() => canStartNewRender ? videoInputRef.current?.click() : setError(accessState.detail || "Editing access is unavailable.")}
            onSelectReferenceImage={() => canStartNewRender ? imageInputRef.current?.click() : setError(accessState.detail || "Editing access is unavailable.")}
            onRemoveVideo={handleRemoveVideo}
            onRemoveReferenceImage={() => setReferenceImage(null)}
            onEditAgain={handleEditAgain}
            canViewPreviousEdit={status === "error" && undoState?.current?.kind === "job"}
            onViewPreviousEdit={handleViewPreviousEdit}
            isOriginalState={undoState?.current?.kind === "original"}
            previewMode={previewMode}
            originalVideo={videos[0] || null}
            restoringOriginal={restoringOriginal}
            originalPreviewArmed={originalPreviewArmed}
            restoringResultUrl={restoringResultUrl}
            onRestoredMediaReady={handleRestoredMediaReady}
            undoAnchor={undoAnchor}
            canUndo={Boolean(undoState?.previous)}
            isUndoing={isUndoing}
            onUndo={handleUndo}
            onBack={handleBackToEmptyState}
            editingDisabled={accessState.blocking}
          />
          <div className="cliponaut-workspace-prompt-area">
            <PromptSuggestions className="is-workspace" onSelect={setPrompt} />
            <div className="cliponaut-mobile-composer-dock">
              <PromptComposer
                inputRef={promptRef}
                prompt={prompt}
                onPromptChange={setPrompt}
                onSubmit={handleGenerate}
                isProcessing={isProcessing}
                canGenerate={Boolean((videos.length || editingSession) && prompt.trim() && canStartNewRender)}
                disabled={accessState.blocking}
                compact
              />
            </div>
          </div>
        </section>
      ) : (
        <EmptyEditorState
          prompt={prompt}
          onPromptChange={setPrompt}
          onSelectVideo={() => videoInputRef.current?.click()}
          onSelectImages={() => imageInputRef.current?.click()}
          onSelectSuggestion={setPrompt}
          imageCount={referenceImage ? 1 : 0}
          error={error}
          disabled={accessState.blocking}
        />
      )}
      {recovery ? (
        <JobRecoveryModal
          active={isActiveJobStatus(recovery.job.status)}
          isResolving={isResolvingRecovery}
          error={recoveryError}
          onContinue={() => restoreJob(recovery.session, recovery.job)}
          onStartFresh={handleRecoveryStartFresh}
        />
      ) : null}
    </main>
  );
}
