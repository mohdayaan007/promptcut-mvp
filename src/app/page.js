"use client";

import { useRef, useState } from "react";

export default function Home() {
  const [video1, setVideo1] = useState(null);
  const [video2, setVideo2] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  const [messages, setMessages] = useState([]);

  const fileRef1 = useRef(null);
  const fileRef2 = useRef(null);

  const generateResponseText = (prompt) => {
    const p = prompt.toLowerCase();
    const responses = [];

    if (p.includes("cinematic")) responses.push("🎬 Cinematic look applied");
    if (p.includes("warm")) responses.push("🔥 Warm tone applied");
    if (p.includes("blue") || p.includes("cool"))
      responses.push("❄️ Cool blue tone applied");
    if (p.includes("black and white") || p.includes("bw"))
      responses.push("🖤 Black & white look applied");
    if (p.includes("add title")) responses.push("🏷️ Title added");

    const trimMatch = p.match(/from\s*(\d+:\d+)\s*to\s*(\d+:\d+)/);
    if (trimMatch) {
      responses.push(`✂️ Exported ${trimMatch[1]} to ${trimMatch[2]}`);
    }

    return responses.length
      ? responses.join(" · ")
      : "✅ Video generated";
  };

  const handleGenerate = async () => {
    if (!video1 || !prompt.trim()) return;

    setMessages((prev) => [...prev, { role: "user", text: prompt }]);
    setStatus("processing");
    setError(null);

    try {
      const formData = new FormData();
      formData.append("video1", video1);
      if (video2) formData.append("video2", video2);
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

      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: generateResponseText(prompt) }
      ]);

      setPrompt("");
    } catch (err) {
      setError(err.message);
      setStatus("error");
    }
  };

  return (
    <main className="min-h-screen bg-black text-white pb-36">
      <div className="max-w-6xl mx-auto p-6 space-y-6">

        {/* HEADER */}
        <div className="flex items-center gap-3">
          <img
            src="/cliponaut.svg"
            alt="Cliponaut logo"
            className="w-8 h-8 rounded-md"
          />
          <div>
            <h1 className="text-2xl font-bold">Cliponaut</h1>
            <p className="text-gray-400 text-sm">
              AI-powered video editing with simple prompts
            </p>
          </div>
        </div>

        {/* MAIN GRID */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-6">

          {/* SOURCE VIDEOS */}
          <div className="md:col-span-2 bg-[#111] rounded-xl p-4 border border-gray-800 min-h-[420px] flex flex-col">
            <h2 className="font-semibold mb-4">Source Videos</h2>

            <label className="cursor-pointer block mb-4">
              <div className="border border-dashed border-gray-600 rounded-md p-4 min-h-[120px] flex items-center justify-center text-center hover:border-gray-400 transition">
                {!video1 ? "⬆️ Upload first video" : `🎬 ${video1.name}`}
              </div>
              <input
                ref={fileRef1}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  setVideo1(e.target.files[0]);
                  setVideo2(null);
                  if (fileRef2.current) fileRef2.current.value = "";
                }}
              />
            </label>

            <label className="cursor-pointer block">
              <div className="border border-dashed border-gray-600 rounded-md p-4 min-h-[120px] flex items-center justify-center text-center hover:border-gray-400 transition">
                {!video2 ? "➕ Add second video (optional)" : `🎬 ${video2.name}`}
              </div>
              <input
                ref={fileRef2}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => setVideo2(e.target.files[0])}
              />
            </label>

            <div className="mt-auto pt-4 border-t border-gray-800 text-sm text-gray-400 space-y-1">
              <p>• Upload one or two videos (Videos merge automatically)</p>
              <p>• Combine instructions in one prompt</p>
              <p>• Generate and download</p>
            </div>
          </div>

          {/* OUTPUT */}
          <div className="md:col-span-3 bg-[#111] rounded-xl p-4 border border-gray-800 min-h-[420px] flex flex-col">
            <h2 className="font-semibold mb-3">Output</h2>

            <div className="aspect-video border border-gray-700 rounded-md bg-black flex items-center justify-center">
              {status === "idle" && "Preview will appear here"}
              {status === "processing" && "⏳ Processing…"}
              {status === "done" && resultUrl && (
                <video
                  src={resultUrl}
                  controls
                  className="w-full h-full object-contain rounded-md"
                />
              )}
              {status === "error" && (
                <span className="text-red-400">❌ {error}</span>
              )}
            </div>

            <a
              href={resultUrl || "#"}
              download="cliponaut.mp4"
              className={`mt-4 text-center py-2 rounded-lg text-sm font-medium ${
                status === "done"
                  ? "bg-white text-black hover:bg-gray-200"
                  : "bg-gray-800 text-gray-500 pointer-events-none"
              }`}
            >
              Download MP4
            </a>
          </div>
        </div>

        {/* CHAT */}
        <div className="space-y-3">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`flex ${
                m.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className="max-w-[75%] px-4 py-2 rounded-lg text-sm"
                style={{
                  backgroundColor:
                    m.role === "user" ? "#1C1C1C" : "#1C2A3A"
                }}
              >
                {m.text}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* PROMPT BAR */}
      <div className="fixed bottom-0 left-0 right-0 bg-black border-t border-gray-800">
        <div className="max-w-4xl mx-auto p-4">
          <div className="flex items-center bg-[#111] border border-gray-700 rounded-xl px-3 min-h-[52px]">
            <textarea
              rows={1}
              className="flex-1 bg-transparent resize-none text-sm py-2 outline-none placeholder-gray-500"
              placeholder="Make it cinematic, add subtitles and trim from 0:45 to 1:20"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleGenerate();
                }
              }}
            />

            <button
              onClick={handleGenerate}
              disabled={status === "processing"}
              className="ml-2 px-4 h-[36px] bg-white text-black rounded-md text-sm font-medium hover:bg-gray-200 disabled:opacity-50 flex items-center justify-center"
            >
              {status === "processing" ? "…" : "Generate"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
