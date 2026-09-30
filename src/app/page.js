"use client";

import { useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/cliponaut/AppHeader";
import { EmptyEditorState } from "@/components/cliponaut/EmptyEditorState";
import { PromptComposer } from "@/components/cliponaut/PromptComposer";
import { PromptSuggestions } from "@/components/cliponaut/PromptSuggestions";
import { Workspace } from "@/components/cliponaut/Workspace";

const MAX_VIDEO_COUNT = 5;

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
  const [images, setImages] = useState([]);
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  const [messages, setMessages] = useState([]);

  const videoInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const promptRef = useRef(null);
  const requestControllerRef = useRef(null);

  const hasWorkspace = Boolean(videos.length || images.length);
  const canExport4k = videos.length > 0 && videoMetadata.length === videos.length && videoMetadata.every(is4kCapable);

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
    const addedImages = Array.from(event.target.files || []);
    if (!addedImages.length) return;

    setImages((currentImages) => [...currentImages, ...addedImages]);
    event.target.value = "";
  };

  const handleRemoveVideo = (index) => {
    setVideos((currentVideos) => currentVideos.filter((_, videoIndex) => videoIndex !== index));
    setVideoMetadata((currentMetadata) => currentMetadata.filter((_, videoIndex) => videoIndex !== index));
    if (videos.length <= 1) setExportQuality("standard");
  };

  const handleGenerate = async () => {
    if (!videos.length || !prompt.trim() || status === "processing") return;

    const submittedPrompt = prompt;
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setMessages((currentMessages) => [
      ...currentMessages,
      { role: "user", text: submittedPrompt },
    ]);
    setStatus("processing");
    setError(null);

    try {
      const formData = new FormData();
      videos.forEach((video) => formData.append("videos", video));
      formData.append("prompt", submittedPrompt);
      formData.append("exportQuality", exportQuality);

      const response = await fetch("/api/process-video", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseError = await response.json();
        throw new Error(responseError.error || "Processing failed");
      }

      const blob = await response.blob();
      if (controller.signal.aborted) return;
      setResultUrl(URL.createObjectURL(blob));
      setStatus("done");
      setMessages((currentMessages) => [
        ...currentMessages,
        { role: "assistant", text: generateResponseText(submittedPrompt) },
      ]);
      setPrompt("");
    } catch (processingError) {
      if (controller.signal.aborted) return;
      setError(processingError.message);
      setStatus("error");
      setMessages((currentMessages) => [
        ...currentMessages,
        { role: "assistant", text: "We couldn’t complete that edit. Please try again." },
      ]);
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

  const handleBackToEmptyState = () => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setVideos([]);
    setVideoMetadata([]);
    setExportQuality("standard");
    setImages([]);
    setPrompt("");
    setStatus("idle");
    setError(null);
    setResultUrl(null);
    setMessages([]);
    if (videoInputRef.current) videoInputRef.current.value = "";
    if (imageInputRef.current) imageInputRef.current.value = "";
  };

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
        accept="image/*"
        multiple
        className="cliponaut-visually-hidden"
        onChange={handleImagesChange}
      />

      {hasWorkspace ? (
        <section className="cliponaut-workspace" aria-label="Video editing workspace">
          <Workspace
            videos={videos}
            images={images}
            status={status}
            error={error}
            resultUrl={resultUrl}
            messages={messages}
            exportQuality={exportQuality}
            canExport4k={canExport4k}
            onExportQualityChange={setExportQuality}
            onSelectVideos={() => videoInputRef.current?.click()}
            onSelectImages={() => imageInputRef.current?.click()}
            onRemoveVideo={handleRemoveVideo}
            onRemoveImage={(index) =>
              setImages((currentImages) => currentImages.filter((_, imageIndex) => imageIndex !== index))
            }
            onEditAgain={handleEditAgain}
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
                isProcessing={status === "processing"}
                canGenerate={Boolean(videos.length && prompt.trim())}
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
          imageCount={images.length}
        />
      )}
    </main>
  );
}
