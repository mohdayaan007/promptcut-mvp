"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AppHeader } from "@/components/cliponaut/AppHeader";
import { EmptyEditorState } from "@/components/cliponaut/EmptyEditorState";
import { PromptComposer } from "@/components/cliponaut/PromptComposer";
import { PromptSuggestions } from "@/components/cliponaut/PromptSuggestions";
import { Workspace } from "@/components/cliponaut/Workspace";
import { JobRecoveryModal } from "@/components/cliponaut/JobRecoveryModal";
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
  promoteSuccessfulJob,
  recordTerminalJob,
  resolveUndoRestoration,
  saveUndoState,
  saveEditingSession,
  clearEditingSession,
  setUndoActiveJob,
  submitConversationTurn,
  terminalAttemptPresentation,
  shouldScheduleUndoOriginalReveal,
  undoPreviewMode,
  uploadAndQueueJob,
  undoMediaReadyAction,
  waitForBrowserPaint,
} from "@/lib/client/direct-upload";

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
    video.onloadedmetadata = () => finish({ width: video.videoWidth, height: video.videoHeight });
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

  const videoInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const promptRef = useRef(null);
  const requestControllerRef = useRef(null);
  const undoStateRef = useRef(null);
  const originalRevealScheduledRef = useRef(false);
  const turnIdRef = useRef(0);
  const presentationAttemptRef = useRef(0);

  const hasWorkspace = Boolean(videos.length || referenceImage || activeJob || undoState?.current);
  const canExport4k = videos.length > 0 && videoMetadata.length === videos.length && videoMetadata.every(is4kCapable);
  const isProcessing = isActiveJobStatus(status);
  const previewMode = undoPreviewMode({ isRestoring: isRestoringPrevious, current: undoState?.current, localVideoCount: videos.length });

  const persistUndoState = useCallback((nextState) => {
    const saved = saveUndoState(nextState);
    undoStateRef.current = saved;
    setUndoState(saved);
    if (saved.current?.kind === "job" && saved.previous) setUndoAnchor(undoAnchorForCurrent(saved.current));
    return saved;
  }, []);

  const showOriginal = useCallback((sources) => {
    setActiveJob(null);
    setRestoredSources(sources || []);
    setStatus("idle");
    setResultUrl(null);
    setError(null);
  }, []);

  const showCompletedJob = useCallback((session, job) => {
    setActiveJob(session);
    setRestoredSources(job.sources || []);
    setStatus("done");
    setResultUrl(job.outputUrl);
    setError(null);
  }, []);

  const showTerminalAttempt = useCallback((job) => {
    const presentation = terminalAttemptPresentation(job);
    setActiveJob(null);
    setRestoredSources(job?.sources || []);
    setStatus(presentation.status);
    setResultUrl(presentation.resultUrl);
    setError(presentation.error);
    setUploadProgress(null);
  }, []);

  const beginPresentationAttempt = useCallback(() => {
    const nextAttempt = presentationAttemptRef.current + 1;
    presentationAttemptRef.current = nextAttempt;
    // Successful history remains in Undo state, but cannot be displayed as the
    // current output while a new attempt is uploading or processing.
    setActiveJob(null);
    setRestoredSources([]);
    setResultUrl(null);
    setIsUndoing(false);
    setIsRestoringPrevious(false);
    setRestoringOriginal(false);
    setOriginalPreviewArmed(false);
    setRestoringResultUrl(null);
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
    setEditingSession(loadEditingSession());
    undoStateRef.current = saved;
    setUndoState(saved);
    setUndoAnchor(getInitialUndoAnchor(saved));
    if (saved.terminal) {
      showTerminalAttempt(saved.terminal);
      return undefined;
    }
    if (!saved.active?.id || !saved.active?.accessToken) {
      if (saved.current) restoreCurrentVersion(saved.current, hydrationAttempt);
      return undefined;
    }
    let stopped = false;
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
          setResultUrl(null);
          setError("We couldn’t check that edit. Please try again.");
        }
      }
    };
    discover();
    return () => { stopped = true; };
  }, [persistUndoState, restoreCurrentVersion, showTerminalAttempt]);

  useEffect(() => {
    if (!activeJob || !isActiveJobStatus(status)) return undefined;
    let stopped = false;
    const pollingAttempt = presentationAttemptRef.current;
    const pollingSession = activeJob;
    const check = async () => {
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
            setMessages((current) => [...current, { role: "assistant", text: job.confirmation || "Your edit is ready." }]);
          } else {
            persistUndoState(recordTerminalJob(undoStateRef.current || emptyUndoState(), pollingSession, { ...job, status: "failed", error: "We couldn’t retrieve that edit." }));
            showTerminalAttempt({ ...job, status: "failed", error: "We couldn’t retrieve that edit." });
            setMessages((current) => [...current, { role: "assistant", text: "We couldn’t retrieve that edit. Your previous version is still available." }]);
          }
        } else if (["failed", "cancelled"].includes(job.status)) {
          persistUndoState(recordTerminalJob(undoStateRef.current || emptyUndoState(), pollingSession, job));
          showTerminalAttempt(job);
          setMessages((current) => [...current, { role: "assistant", text: job.status === "cancelled" ? "This edit was cancelled. Your previous version is still available." : "We couldn’t complete that edit. Your previous version is still available." }]);
        }
      } catch (statusError) {
        if (!stopped && isCurrentPresentationAttempt(pollingAttempt, presentationAttemptRef.current)) setError(statusError.message);
      }
    };
    check();
    const timer = setInterval(check, 3_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [activeJob, persistUndoState, showCompletedJob, showTerminalAttempt, status]);

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
    const addedVideos = Array.from(event.target.files || []);
    event.target.value = "";
    if (!addedVideos.length) return;

    const acceptedVideos = addedVideos.slice(0, Math.max(0, MAX_VIDEO_COUNT - videos.length));
    if (!acceptedVideos.length) {
      setError(`You can upload up to ${MAX_VIDEO_COUNT} videos at a time.`);
      return;
    }
    if (addedVideos.length > acceptedVideos.length) setError(`Only the first ${MAX_VIDEO_COUNT} videos can be added.`);
    setVideos((currentVideos) => [...currentVideos, ...acceptedVideos]);
    const metadata = await Promise.all(acceptedVideos.map(getBrowserVideoMetadata));
    setVideoMetadata((currentMetadata) => [...currentMetadata, ...metadata]);
  };

  const handleImagesChange = (event) => {
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

    const submittedPrompt = prompt;
    const presentationAttempt = beginPresentationAttempt();
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
        const turn = await submitConversationTurn(editingSession, submittedPrompt, controller.signal);
        if (controller.signal.aborted || !isCurrentPresentationAttempt(presentationAttempt, presentationAttemptRef.current)) return;
        const nextSession = saveEditingSession(turn.session);
        setEditingSession(nextSession);
        persistUndoState(setUndoActiveJob(undoStateRef.current || emptyUndoState(), turn.job, submittedPrompt));
        setActiveJob(turn.job);
        setStatus("queued");
        setPrompt("");
        return;
      }
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
        setMessages((currentMessages) => [...currentMessages, { role: "assistant", text: job.status === "cancelled" ? "This edit was cancelled. Your previous version is still available." : "We couldn’t complete that edit. Your previous version is still available." }]);
        return;
      }
      setStatus(job.status);
      setUploadProgress(null);
      setPrompt("");
    } catch (processingError) {
      if (controller.signal.aborted || !isCurrentPresentationAttempt(presentationAttempt, presentationAttemptRef.current)) return;
      persistUndoState(discardUndoActiveJob(undoStateRef.current || emptyUndoState()));
      showTerminalAttempt({ status: "failed", error: processingError.message });
      setMessages((currentMessages) => [...currentMessages, { role: "assistant", text: "We couldn’t complete that edit. Your previous version is still available." }]);
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

  const restoreJob = (session, job) => {
    if (job.status === "completed" && job.outputUrl) showCompletedJob(session, job);
    else {
      setActiveJob(session);
      setRestoredSources(job.sources || []);
      setStatus(job.status);
      setResultUrl(null);
    }
    const current = undoStateRef.current?.current;
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

      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        multiple
        className="cliponaut-visually-hidden"
        onChange={handleVideosChange}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="cliponaut-visually-hidden"
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
            onSelectVideos={() => videoInputRef.current?.click()}
            onSelectReferenceImage={() => imageInputRef.current?.click()}
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
                canGenerate={Boolean((videos.length || editingSession) && prompt.trim())}
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
