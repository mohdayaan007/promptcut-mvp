/* eslint-disable @next/next/no-img-element -- Blob URLs are local previews and cannot use Next image optimization. */
import { useEffect, useMemo, useRef, useState } from "react";
import { AttachmentControls } from "@/components/cliponaut/AttachmentControls";
import { ArrowLeftIcon, DownloadIcon, ImageIcon, PlusIcon, VideoIcon } from "@/components/cliponaut/icons";

export function Workspace({
  video1,
  video2,
  images,
  status,
  error,
  resultUrl,
  messages,
  onSelectPrimaryVideo,
  onSelectSecondVideo,
  onSelectImages,
  onRemovePrimaryVideo,
  onRemoveSecondVideo,
  onRemoveImage,
  onEditAgain,
  onBack,
}) {
  return (
    <>
      <button className="cliponaut-back-button" type="button" onClick={onBack}>
        <ArrowLeftIcon />
        Back
      </button>
    <div className="cliponaut-workspace-grid">
      <section className="cliponaut-panel cliponaut-media-panel" aria-labelledby="media-heading">
        <div className="cliponaut-panel-heading">
          <div>
            <p className="cliponaut-panel-kicker">Source</p>
            <h1 id="media-heading">Your media</h1>
          </div>
          <button className="cliponaut-text-button" type="button" onClick={onSelectPrimaryVideo}>
            {video1 ? "Replace" : "Add video"}
          </button>
        </div>

        <div className="cliponaut-media-list">
          {video1 && <MediaCard file={video1} kind="video" onRemove={onRemovePrimaryVideo} />}
          {video2 && <MediaCard file={video2} kind="video" onRemove={onRemoveSecondVideo} />}
          {images.map((image, index) => (
            <MediaCard key={`${image.name}-${index}`} file={image} kind="image" onRemove={() => onRemoveImage(index)} />
          ))}
        </div>

        <div className="cliponaut-media-actions">
          {!video2 && (
            <button
              className="cliponaut-add-media"
              type="button"
              onClick={video1 ? onSelectSecondVideo : onSelectPrimaryVideo}
            >
              <PlusIcon />
              {video1 ? "Add another video" : "Add a video"}
            </button>
          )}
          <button className="cliponaut-add-media" type="button" onClick={onSelectImages}>
            <ImageIcon />
            Add images
          </button>
        </div>
        <p className="cliponaut-media-note">Images are kept locally for a future editing feature and are not sent to render yet.</p>
      </section>

      <PreviewPanel
        status={status}
        error={error}
        resultUrl={resultUrl}
        messages={messages}
        onEditAgain={onEditAgain}
      />
    </div>
    <ConversationFeedback messages={messages} status={status} />
    </>
  );
}

function MediaCard({ file, kind, onRemove }) {
  const sourceUrl = useObjectUrl(file);
  const [duration, setDuration] = useState(null);

  return (
    <article className="cliponaut-media-card">
      <div className="cliponaut-media-thumbnail">
        {kind === "video" ? (
          <video
            src={sourceUrl}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          />
        ) : (
          <img src={sourceUrl} alt="" />
        )}
        <span className="cliponaut-media-type">{kind === "video" ? <VideoIcon /> : <ImageIcon />}</span>
      </div>
      <div className="cliponaut-media-details">
        <p title={file.name}>{file.name}</p>
        <span>{kind === "video" ? (duration ? formatDuration(duration) : "Loading duration…") : "Image attachment"}</span>
      </div>
      <button className="cliponaut-remove-media" type="button" onClick={onRemove} aria-label={`Remove ${file.name}`}>
        ×
      </button>
    </article>
  );
}

function PreviewPanel({ status, error, resultUrl, messages, onEditAgain }) {
  const videoRef = useRef(null);
  const [playbackRate, setPlaybackRate] = useState("1");

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = Number(playbackRate);
  }, [playbackRate, resultUrl]);

  const handlePlaybackRateChange = (event) => {
    const nextRate = event.target.value;
    setPlaybackRate(nextRate);
  };

  return (
    <section className="cliponaut-panel cliponaut-preview-panel" aria-labelledby="preview-heading">
      <div className="cliponaut-panel-heading">
        <div>
          <p className="cliponaut-panel-kicker">Output</p>
          <h2 id="preview-heading">Preview</h2>
        </div>
        {status === "done" && <span className="cliponaut-status-badge">Ready</span>}
      </div>

      <div className={`cliponaut-preview-stage is-${status}`}>
        {status === "idle" && <PreviewEmptyState />}
        {status === "processing" && <PreviewProcessingState />}
        {status === "error" && <PreviewErrorState error={error} />}
        {status === "done" && resultUrl && (
          <video ref={videoRef} src={resultUrl} controls playsInline className="cliponaut-result-video" />
        )}
      </div>

      {status === "done" && resultUrl && (
        <div className="cliponaut-preview-actions">
          <label className="cliponaut-speed-control">
            <span>Speed</span>
            <select value={playbackRate} onChange={handlePlaybackRateChange} aria-label="Playback speed">
              <option value="0.5">0.5×</option>
              <option value="1">1×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2×</option>
            </select>
          </label>
          <a className="cliponaut-download-button" href={resultUrl} download="cliponaut.mp4">
            <DownloadIcon />
            Download MP4
          </a>
          <button className="cliponaut-edit-again" type="button" onClick={onEditAgain}>
            Edit again
          </button>
        </div>
      )}
    </section>
  );
}

function ConversationFeedback({ messages, status }) {
  const isVisible = messages.length || status === "processing";
  if (!isVisible) return null;

  return (
    <section className="cliponaut-conversation" aria-live="polite" aria-label="Editing activity">
      {messages.map((message, index) => (
        <div className={`cliponaut-conversation-message is-${message.role}`} key={`${message.role}-${index}`}>
          <span>{message.role === "user" ? "You" : "Cliponaut"}</span>
          <p>{message.text}</p>
        </div>
      ))}
      {status === "processing" && (
        <div className="cliponaut-conversation-message is-assistant is-processing">
          <span>Cliponaut</span>
          <p>Editing your video…</p>
        </div>
      )}
    </section>
  );
}

function PreviewEmptyState() {
  return (
    <div className="cliponaut-preview-placeholder">
      <VideoIcon />
      <p>Your finished video will appear here.</p>
    </div>
  );
}

function PreviewProcessingState() {
  return (
    <div className="cliponaut-preview-placeholder">
      <span className="cliponaut-processing-orbit" aria-hidden="true" />
      <p>Making your edit…</p>
    </div>
  );
}

function PreviewErrorState({ error }) {
  return (
    <div className="cliponaut-preview-placeholder is-error" role="alert">
      <p>We couldn’t generate that video.</p>
      <span>{error || "Please try again."}</span>
    </div>
  );
}

function useObjectUrl(file) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return url;
}

function formatDuration(duration) {
  if (!Number.isFinite(duration)) return "Duration unavailable";
  const totalSeconds = Math.floor(duration);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
