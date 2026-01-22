"use client";

import { useRef, useState } from "react";

export default function Home() {
  const [video1, setVideo1] = useState(null);
  const [video2, setVideo2] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("idle"); // idle | processing | done | error
  const [error, setError] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);

  const fileRef1 = useRef(null);
  const fileRef2 = useRef(null);

  const resetAll = () => {
    setVideo1(null);
    setVideo2(null);
    setPrompt("");
    setStatus("idle");
    setError(null);
    setResultUrl(null);

    if (fileRef1.current) fileRef1.current.value = "";
    if (fileRef2.current) fileRef2.current.value = "";
  };

  const handleGenerate = async () => {
    if (!video1 || !video2) {
      alert("Please upload two videos.");
      return;
    }

    if (!prompt.trim()) {
      alert("Please enter a prompt.");
      return;
    }

    setStatus("processing");
    setError(null);
    setResultUrl(null);

    try {
      const formData = new FormData();
      formData.append("video1", video1);
      formData.append("video2", video2);
      formData.append("prompt", prompt);

      const res = await fetch("/api/process-video", {
        method: "POST",
        body: formData
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Processing failed");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setStatus("done");
    } catch (err) {
      console.error(err);
      setError(err.message);
      setStatus("error");
    }
  };

  return (
    <main className="min-h-screen bg-black text-white p-4 sm:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold">PromptCut</h1>
          <p className="text-gray-400 text-sm">
            Edit videos using natural language
          </p>
        </div>

        <div className="bg-[#111] rounded-lg p-4 border border-gray-800">
          <h2 className="font-semibold mb-2">How it works</h2>
          <ol className="list-decimal list-inside text-sm text-gray-400 space-y-1">
            <li>Upload two videos</li>
            <li>Describe what you want</li>
            <li>Click Generate</li>
            <li>Download your edited video</li>
          </ol>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-[#111] rounded-lg p-4 border border-gray-800 space-y-3">
            <h2 className="font-semibold">Source Videos</h2>

            <div>
              <label className="text-sm text-gray-400">Video 1</label>
              <input
                ref={fileRef1}
                type="file"
                accept="video/*"
                className="block w-full text-sm mt-1"
                onChange={(e) => setVideo1(e.target.files[0])}
              />
            </div>

            <div>
              <label className="text-sm text-gray-400">Video 2</label>
              <input
                ref={fileRef2}
                type="file"
                accept="video/*"
                className="block w-full text-sm mt-1"
                onChange={(e) => setVideo2(e.target.files[0])}
              />
            </div>
          </div>

          <div className="bg-[#111] rounded-lg p-4 border border-gray-800 space-y-3">
            <h2 className="font-semibold">Edit Prompt</h2>

            <textarea
              className="w-full h-32 bg-black border border-gray-700 rounded p-2 text-sm resize-none"
              placeholder="Example: Add title: My Day in Wayanad at 0:05"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />

            <button
              onClick={handleGenerate}
              disabled={status === "processing"}
              className="w-full bg-white text-black py-2 rounded font-medium hover:bg-gray-200 disabled:opacity-50"
            >
              {status === "processing" ? "Processing..." : "Generate Video"}
            </button>

            {status !== "idle" && (
              <button
                onClick={resetAll}
                className="w-full text-sm text-gray-400 underline"
              >
                Reset
              </button>
            )}
          </div>

          <div className="bg-[#111] rounded-lg p-4 border border-gray-800 flex flex-col">
            <h2 className="font-semibold mb-2">Output</h2>

            <div className="flex-1 border border-gray-700 rounded p-3 text-sm text-gray-400 flex items-center justify-center text-center min-h-[140px]">
              {status === "idle" && "Your edited video will appear here."}
              {status === "processing" && "⏳ Generating your video…"}
              {status === "done" && "✅ Your video is ready"}
              {status === "error" && (
                <span className="text-red-400">
                  ❌ {error || "Something went wrong"}
                </span>
              )}
            </div>

            <a
              href={resultUrl || "#"}
              download="promptcut.mp4"
              className={`mt-3 text-center py-2 rounded text-sm ${
                status === "done"
                  ? "bg-white text-black hover:bg-gray-200"
                  : "bg-gray-800 text-gray-500 pointer-events-none"
              }`}
            >
              Download MP4
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
