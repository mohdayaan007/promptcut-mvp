export default function LandingPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-6xl mx-auto px-6">

        {/* HERO */}
        <section className="pt-28 pb-16 text-center">
          <h1 className="text-5xl md:text-6xl font-semibold tracking-tight">
            Video editing, simplified by AI.
          </h1>

          <p className="mt-6 text-lg md:text-lg text-gray-400 max-w-3xl mx-auto">
            Edit your clips by describing the changes you want. No timelines, no learning curve.
          </p>

          <div className="mt-6 flex flex-col items-center gap-3">
            <a
              href="/editor"
              className="px-7 py-3 bg-white text-black rounded-md text-sm font-medium hover:bg-gray-200 transition"
            >
              Start Editing for Free
            </a>

            <p className="text-xs text-gray-500">
              Built for a desktop experience. Mobile coming soon.
            </p>
          </div>

          {/* HERO DEMO VIDEO */}
          <div className="mt-10 mx-auto max-w-4xl rounded-xl overflow-hidden border border-gray-800">
            <video
              src="/demo.mp4"
              autoPlay
              muted
              loop
              playsInline
              className="w-full h-full object-cover"
            />
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
          <p className="max-w-xl mx-auto text-center italic text-gray-300 leading-relaxed">
            Most video editors are built for Hollywood, but most people just need
            a quick fix. Cliponaut is built for “10-second edits” — trimming a
            clip, joining two videos, or adding a title — tasks that should take
            seconds, not minutes.
          </p>
        </section>

        {/* FOOTER */}
        <section className="py-14 text-center text-sm text-gray-500">
          Have a suggestion? Connect with the founder on{" "}
          <a
            href="https://x.com/uxayaan"
            target="_blank"
            className="underline hover:text-gray-300"
          >
            X
          </a>
          .
        </section>

      </div>
    </main>
  );
}

/* ---------- Components ---------- */

function Step({ icon, title, text }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-center">{icon}</div>
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="text-gray-400 max-w-xs mx-auto">{text}</p>
    </div>
  );
}

function FeatureCard({ icon, title, text, example }) {
  return (
    <div className="border border-gray-800 rounded-xl p-6 space-y-3">
      <div>{icon}</div>
      <h3 className="font-medium tracking-wide">{title}</h3>
      <p className="text-gray-400 text-sm">{text}</p>
      {example && (
        <p className="text-xs text-gray-500 italic">e.g. “{example}”</p>
      )}
    </div>
  );
}

/* ---------- Icons ---------- */

const iconBase = (path) => (
  <svg
    className="w-6 h-6 text-gray-300"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    viewBox="0 0 24 24"
  >
    {path}
  </svg>
);

function UploadIcon() {
  return iconBase(<path d="M12 16V4m0 0-4 4m4-4 4 4M4 20h16" />);
}

function PromptIcon() {
  return iconBase(
    <path d="M4 5h16v10H7l-3 4V5z" />
  );
}

function ExportIcon() {
  return iconBase(
    <path d="M12 4v12m0 0 4-4m-4 4-4-4M4 20h16" />
  );
}

function TrimIcon() {
  return iconBase(
    <path d="M4 4l16 16M4 20L20 4" />
  );
}

function PaletteIcon() {
  return iconBase(
    <path d="M12 3a9 9 0 1 0 0 18 2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h5a4 4 0 0 0 0-8h-1" />
  );
}

function TitleIcon() {
  return iconBase(
    <path d="M4 4h16M12 4v16" />
  );
}

function MergeIcon() {
  return iconBase(
    <path d="M7 3v6a4 4 0 0 0 4 4h2m0 0v4l4-4-4-4" />
  );
}
