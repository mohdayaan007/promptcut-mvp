"use client";
import { useRef } from "react";

export default function LandingPage() {
  const videoRef = useRef(null);

  const changeSpeed = (speed) => {
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
  };

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-6xl mx-auto px-6">

        {/* HERO */}
        <section className="pt-28 pb-16 text-center">
          <h1 className="text-5xl md:text-6xl font-semibold tracking-tight">
            Video editing, simplified by AI.
          </h1>

          <p className="mt-6 text-lg max-w-3xl mx-auto text-[#8A8F98]">
            Edit your clips by describing the changes you want. No timelines, no learning curve.
          </p>

          <div className="mt-6 flex flex-col items-center gap-3">
            <a
              href="/editor"
              className="px-7 py-3 bg-white text-black rounded-md text-sm font-medium hover:bg-gray-200 transition"
            >
              Start Editing for Free
            </a>

            <p className="text-xs text-[#8A8F98]">
              Built for a desktop experience. Mobile coming soon.
            </p>
          </div>

          {/* HERO DEMO VIDEO */}
          <div className="mt-10 mx-auto max-w-4xl rounded-xl overflow-hidden border border-gray-800">
            <video
              ref={videoRef}
              src="/demo.mp4"
              controls
              playsInline
              className="w-full h-full object-cover"
            />
          </div>

          {/* SPEED CONTROLS */}
          <div className="mt-4 flex justify-center gap-3 text-sm text-[#8A8F98]">
            <button onClick={() => changeSpeed(0.5)} className="hover:text-white transition">0.5x</button>
            <button onClick={() => changeSpeed(1)} className="hover:text-white transition">1x</button>
            <button onClick={() => changeSpeed(1.5)} className="hover:text-white transition">1.5x</button>
            <button onClick={() => changeSpeed(2)} className="hover:text-white transition">2x</button>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section className="py-16 grid grid-cols-1 md:grid-cols-3 gap-12 text-center">
          <Step icon={<UploadIcon />} title="Upload" text="Drop 1 or 2 clips. We auto-merge if needed." />
          <Step icon={<PromptIcon />} title="Prompt" text="Describe your edit clearly in one sentence." />
          <Step icon={<ExportIcon />} title="Export" text="Download a perfectly synced MP4." />
        </section>

        {/* FEATURES */}
        <section className="py-16">
          <h2 className="text-2xl font-medium text-center mb-12">
            What Cliponaut can do
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <FeatureCard
              icon={<TrimIcon />}
              title="Prompt-based trimming"
              text="Tell us the timestamps. We handle the cuts."
              example="Trim from 0:05 to 0:12"
            />
            <FeatureCard
              icon={<PaletteIcon />}
              title="Natural color grading"
              text="Change the look instantly without touching a color wheel."
              example="Make the video cinematic"
            />
            <FeatureCard
              icon={<TitleIcon />}
              title="Instant title overlays"
              text="Add text exactly when you need it."
              example="Add title: How I made $1000 at 0:05"
            />
            <FeatureCard
              icon={<MergeIcon />}
              title="Zero-config merging"
              text="Upload two clips and they join automatically."
            />
          </div>
        </section>

        {/* WHY */}
        <section className="py-16">
          <p className="max-w-xl mx-auto text-center italic text-[#8A8F98] leading-relaxed">
            Most video editors are built for Hollywood, but most people just need
            a quick fix. Cliponaut is built for “10-second edits” — trimming a
            clip, joining two videos, or adding a title — tasks that should take
            seconds, not minutes.
          </p>
        </section>

        {/* FOOTER */}
        <section className="py-14 text-center text-sm text-[#8A8F98]">
          Have a suggestion? Connect with the founder on{" "}
          <a
            href="https://x.com/uxayaan"
            target="_blank"
            className="underline hover:text-white transition"
          >
            X
          </a>
          .
        </section>

      </div>
    </main>
  );
}
