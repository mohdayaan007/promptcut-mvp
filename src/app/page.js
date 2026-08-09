"use client";

import { useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/cliponaut/AppHeader";
import { EmptyEditorState } from "@/components/cliponaut/EmptyEditorState";
import { PromptComposer } from "@/components/cliponaut/PromptComposer";
import { PromptSuggestions } from "@/components/cliponaut/PromptSuggestions";
import { Workspace } from "@/components/cliponaut/Workspace";

export default function HomePage() {
  const [video1, setVideo1] = useState(null);
  const [video2, setVideo2] = useState(null);
  const [images, setImages] = useState([]);
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  const [messages, setMessages] = useState([]);

  const video1InputRef = useRef(null);
  const video2InputRef = useRef(null);
  const imageInputRef = useRef(null);
  const promptRef = useRef(null);
  const requestControllerRef = useRef(null);

  const hasWorkspace = Boolean(video1 || images.length);

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
    if (video2 || lowerCasePrompt.includes("merge")) responses.push("Videos merged.");

    return responses.length ? responses.join(" ") : "Your edit is ready.";
  };

  const handlePrimaryVideoChange = (event) => {
    const [file] = event.target.files;
    if (!file) return;

    // The API supports two videos. Replacing the first input intentionally clears
    // the optional second input, matching the existing editor behavior.
    setVideo1(file);
    setVideo2(null);
    if (video2InputRef.current) video2InputRef.current.value = "";
    event.target.value = "";
  };

  const handleSecondVideoChange = (event) => {
    const [file] = event.target.files;
    if (!file) return;

    setVideo2(file);
    event.target.value = "";
  };

  const handleImagesChange = (event) => {
    const addedImages = Array.from(event.target.files || []);
    if (!addedImages.length) return;

    setImages((currentImages) => [...currentImages, ...addedImages]);
    event.target.value = "";
  };

  const handleRemovePrimaryVideo = () => {
    if (video2) {
      setVideo1(video2);
      setVideo2(null);
    } else {
      setVideo1(null);
    }

    if (video1InputRef.current) video1InputRef.current.value = "";
    if (video2InputRef.current) video2InputRef.current.value = "";
  };

  const handleRemoveSecondVideo = () => {
    setVideo2(null);
    if (video2InputRef.current) video2InputRef.current.value = "";
  };

  const handleGenerate = async () => {
    if (!video1 || !prompt.trim() || status === "processing") return;

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
      formData.append("video1", video1);
      if (video2) formData.append("video2", video2);
      formData.append("prompt", submittedPrompt);

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
    setVideo1(null);
    setVideo2(null);
    setImages([]);
    setPrompt("");
    setStatus("idle");
    setError(null);
    setResultUrl(null);
    setMessages([]);
    if (video1InputRef.current) video1InputRef.current.value = "";
    if (video2InputRef.current) video2InputRef.current.value = "";
    if (imageInputRef.current) imageInputRef.current.value = "";
  };

  return (
    <main className={`cliponaut-shell ${hasWorkspace ? "is-workspace" : "is-empty"}`}>
      <AppHeader />

      <input
        ref={video1InputRef}
        type="file"
        accept="video/*"
        className="cliponaut-visually-hidden"
        onChange={handlePrimaryVideoChange}
      />
      <input
        ref={video2InputRef}
        type="file"
        accept="video/*"
        className="cliponaut-visually-hidden"
        onChange={handleSecondVideoChange}
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
            video1={video1}
            video2={video2}
            images={images}
            status={status}
            error={error}
            resultUrl={resultUrl}
            messages={messages}
            onSelectPrimaryVideo={() => video1InputRef.current?.click()}
            onSelectSecondVideo={() => video2InputRef.current?.click()}
            onSelectImages={() => imageInputRef.current?.click()}
            onRemovePrimaryVideo={handleRemovePrimaryVideo}
            onRemoveSecondVideo={handleRemoveSecondVideo}
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
                canGenerate={Boolean(video1 && prompt.trim())}
                compact
              />
            </div>
          </div>
        </section>
      ) : (
        <EmptyEditorState
          prompt={prompt}
          onPromptChange={setPrompt}
          onSelectVideo={() => video1InputRef.current?.click()}
          onSelectImages={() => imageInputRef.current?.click()}
          onSelectSuggestion={setPrompt}
          imageCount={images.length}
        />
      )}
    </main>
  );
}
