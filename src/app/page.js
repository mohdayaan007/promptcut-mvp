"use client";

import { useState } from "react";

export default function Home() {
  const [video1, setVideo1] = useState(null);
  const [video2, setVideo2] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | processing | done
  const [result, setResult] = useState(null);

  const handleGenerate = async () => {
    if (!video1 || !video2) {
      alert("Please upload two videos first.");
      return;
    }

    if (!prompt.trim()) {
      alert("Describe what you want to do.");
      return;
    }

    setIsProcessing(true);
    setStatus("processing");
    setResult(null);

    try {
      const res = await fetch("/api/process-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          video1: video1.name,
          video2: video2.name,
        }),
      });

      const data = await res.json();
      if (!data.success) throw new Error("Failed");

      const binary = atob(data.base64);
      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const blob = new Blob([bytes], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);

      setResult({ outputUrl: url, filename: data.filename });
      setStatus("done");
    } catch (err) {
      alert("Something went wrong.");
      setStatus("idle");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <main className="min-h-screen bg-black text-white p-4 sm:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">PromptCut</h1>
          <p className="text-gray-400 text-sm">
            Edit videos using natural language
          </p>
        </div>

        {/* How it works */}
        <div className="bg-[#111] rounded-lg p-4 border border-gray-800">
          <h2 className="font-semibold mb-2">How it works</h2>
          <ol className="list-decimal list-inside text-sm text-gray-400 space-y-1">
            <li>Upload two videos</li>
            <li>Describe what you want</li>
            <li>Click Generate</li>
            <li>Download your edited video</li>
          </ol>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Source videos */}
          <div className="bg-[#111] rounded-lg p-4 border border-gray-800 space-y-3">
            <h2 className="font-semibold">Source Videos</h2>

            <div>
              <label className="text-sm text-gray-400">Video 1</label>
              <input
                type="file"
                accept="video/*"
                className="block w-full text-sm mt-1"
                onChange={(e) => setVideo1(e.target.files[0])}
              />
            </div>

            <div>
              <label className="text-sm text-gray-400">Video 2</label>
              <input
                type="file"
                accept="video/*"
                className="block w-full text-sm mt-1"
                onChange={(e) => setVideo2(e.target.files[0])}
              />
            </div>
          </div>

          {/* Prompt */}
          <div className="bg-[#111] rounded-lg p-4 border border-gray-800 space-y-3">
            <h2 className="font-semibold">Edit Prompt</h2>

            <textarea
              className="w-full h-32 bg-black border border-gray-700 rounded p-2 text-sm resize-none"
              placeholder="Describe how you want to edit your videos..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />

            <div className="text-xs text-gray-500 space-y-1">
              <p>Examples:</p>
              <ul className="list-disc list-inside">
                <li>Merge both videos and add a title</li>
                <li>Add a black & white filter</li>
                <li>Smooth transitions between clips</li>
              </ul>
            </div>

            <button
              onClick={handleGenerate}
              disabled={isProcessing}
              className="w-full bg-white text-black py-2 rounded font-medium hover:bg-gray-200 disabled:opacity-50"
            >
              {isProcessing ? "Processing..." : "Generate Video"}
            </button>
          </div>

          {/* Output */}
          <div className="bg-[#111] rounded-lg p-4 border border-gray-800 flex flex-col">
            <h2 className="font-semibold mb-2">Output</h2>

            <div className="flex-1 border border-gray-700 rounded p-3 text-sm text-gray-400 flex items-center justify-center text-center min-h-[140px]">
              {status === "idle" && "Your edited video will appear here."}
              {status === "processing" && "⏳ Generating your video…"}
              {status === "done" && (
                <div className="space-y-2">
                  <div className="text-green-400">✅ Your video is ready</div>
                  <div className="text-xs text-gray-400 break-all">
                    File: {result?.filename}
                  </div>
                </div>
              )}
            </div>

            <a
              href={result?.outputUrl || "#"}
              download={result?.filename}
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
