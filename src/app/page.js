"use client";

import { useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/cliponaut/AppHeader";
import { EmptyEditorState } from "@/components/cliponaut/EmptyEditorState";
import { PromptComposer } from "@/components/cliponaut/PromptComposer";
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

  const hasWorkspace = Boolean(video1 || images.length);

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  const generateResponseText = (value) => {
    const lowerCasePrompt = value.toLowerCase();
    const responses = [];

    if (lowerCasePrompt.includes("cinematic")) responses.push("Cinematic look applied");
    if (lowerCasePrompt.includes("warm")) responses.push("Warm tone applied");
    if (lowerCasePrompt.includes("blue") || lowerCasePrompt.includes("cool")) {
      responses.push("Cool blue tone applied");
    }
    if (lowerCasePrompt.includes("black and white") || lowerCasePrompt.includes("bw")) {
      responses.push("Black & white look applied");
    }
    if (lowerCasePrompt.includes("add title")) responses.push("Title added");

    const trimMatch = lowerCasePrompt.match(/from\s*(\d+:\d+)\s*to\s*(\d+:\d+)/);
    if (trimMatch) responses.push(`Exported ${trimMatch[1]} to ${trimMatch[2]}`);

    return responses.length ? responses.join(" · ") : "Video generated";
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
      });

      if (!response.ok) {
        const responseError = await response.json();
        throw new Error(responseError.error || "Processing failed");
      }

      const blob = await response.blob();
      setResultUrl(URL.createObjectURL(blob));
      setStatus("done");
      setMessages((currentMessages) => [
        ...currentMessages,
        { role: "assistant", text: generateResponseText(submittedPrompt) },
      ]);
      setPrompt("");
    } catch (processingError) {
      setError(processingError.message);
      setStatus("error");
    }
  };

  const handleEditAgain = () => {
    setResultUrl(null);
    setStatus("idle");
    setError(null);
    promptRef.current?.focus();
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
          />
          <PromptComposer
            inputRef={promptRef}
            prompt={prompt}
            onPromptChange={setPrompt}
            onSubmit={handleGenerate}
            isProcessing={status === "processing"}
            canGenerate={Boolean(video1 && prompt.trim())}
            compact
          />
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
