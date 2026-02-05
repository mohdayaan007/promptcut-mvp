export default function LandingPage() {
  return (
    <main className="min-h-screen bg-black text-white font-serif">
      <div className="max-w-5xl mx-auto px-6">

        {/* HERO */}
        <section className="pt-24 pb-16 text-center space-y-4">
          <h1 className="text-5xl md:text-6xl font-semibold leading-tight">
            AI-powered video editing
          </h1>

          <p className="text-lg md:text-xl text-gray-300">
            Just type what you want.
          </p>

          <p className="text-base text-gray-400 max-w-2xl mx-auto pt-2">
            Cliponaut uses AI to turn simple text instructions into video edits —
            without timelines, manual tools, or a learning curve.
          </p>

          <div className="pt-5 flex flex-col items-center gap-3">
            <a
              href="/editor"
              className="inline-flex items-center px-6 py-3 bg-white text-black rounded-md text-sm font-medium hover:bg-gray-200 transition"
            >
              Try the MVP →
            </a>

            <p className="text-sm text-gray-400">
              No signup · Upload → type → download
            </p>

            <p className="text-xs text-gray-500">
              Desktop recommended · Short clips work best
            </p>
          </div>
        </section>

        <Divider />

        {/* WHO */}
        <section className="py-12 space-y-3 max-w-2xl mx-auto">
          <h2 className="text-2xl font-medium">Who is this for?</h2>
          <p className="text-gray-400 text-lg">
            Cliponaut is for people who want to edit and export videos in minutes,
            without opening complex video editing software.
          </p>
        </section>

        <Divider />

        {/* FEATURES */}
        <section className="py-12 space-y-12">
          <h2 className="text-2xl font-medium text-center">
            What Cliponaut can do today
          </h2>

          <Feature
            title="Color grading"
            description="Apply a look using simple language."
            examples={[
              "Make it cinematic",
              "Make it warm",
              "Make it blue",
              "Make it black and white",
            ]}
          />

          <Feature
            title="Trim clips"
            description="Export only the part you need."
            examples={[
              "Trim from 0:05 to 0:10",
              "Keep only 1:41 to 1:46",
            ]}
          />

          <Feature
            title="Add titles"
            description="Add simple text overlays at a specific time."
            examples={[
              "Add title: My Trip at 0:03",
              "Add title: Hello World at 0:10",
            ]}
          />

          <Feature
            title="Auto-merge videos"
            description="Upload two videos and Cliponaut automatically merges them."
            examples={[
              "Upload two videos → Make it cinematic",
            ]}
          />
        </section>

        <Divider />

        {/* HOW */}
        <section className="py-12 space-y-3 max-w-2xl mx-auto">
          <h2 className="text-2xl font-medium">How it works</h2>
          <ol className="space-y-2 text-gray-400 text-lg">
            <li>1. Upload one or two videos</li>
            <li>2. Type a single prompt (you can combine instructions)</li>
            <li>3. Generate and download your video</li>
          </ol>
          <p className="text-gray-400">That’s it.</p>
        </section>

        <Divider />

        {/* CLARITY */}
        <section className="py-12 space-y-3 max-w-2xl mx-auto">
          <h2 className="text-2xl font-medium">How to get the best results</h2>

          <p className="text-gray-400 text-lg">
            Cliponaut works best with clear, explicit instructions —
            exact trim times, simple color styles, and straightforward titles.
          </p>

          <p className="text-gray-500">
            Advanced creative edits (vibes, music, smart cuts, positioning)
            are part of the long-term vision and will come later.
          </p>
        </section>

        <Divider />

        {/* COMING SOON */}
        <section className="py-12 space-y-3 max-w-2xl mx-auto">
          <h2 className="text-2xl font-medium">Coming soon</h2>
          <ul className="space-y-2 text-gray-400">
            <li>Smarter AI-based edits</li>
            <li>More expressive prompts</li>
            <li>Better text styling</li>
            <li>Faster processing</li>
            <li>Expanded editing actions</li>
          </ul>
        </section>

        <Divider />

        {/* WHY + CTA */}
        <section className="py-12 space-y-4 max-w-2xl mx-auto">
          <h2 className="text-2xl font-medium">Why Cliponaut exists?</h2>

          <p className="text-gray-400 text-lg">
            Most people don’t edit videos every day.
            Opening a full timeline editor for one small change feels heavy.
          </p>

          <p className="text-lg">
            What if video editing worked like giving instructions? That's exactly what Cliponaut is!
          </p>

          <div className="pt-2 flex flex-col items-start gap-2">
            <a
              href="/editor"
              className="inline-flex items-center px-6 py-3 bg-white text-black rounded-md text-sm font-medium hover:bg-gray-200 transition"
            >
              Try Cliponaut →
            </a>
      
          </div>
        </section>

      </div>
    </main>
  );
}

/* ---------- Components ---------- */

function Divider() {
  return <div className="border-t border-gray-800" />;
}

function Feature({ title, description, examples }) {
  return (
    <div className="space-y-3 max-w-2xl mx-auto">
      <h3 className="text-xl font-medium">{title}</h3>
      <p className="text-gray-400">{description}</p>
      <div className="flex flex-wrap gap-2">
        {examples.map((ex) => (
          <span
            key={ex}
            className="px-3 py-1 text-sm bg-[#111] border border-gray-800 rounded"
          >
            {ex}
          </span>
        ))}
      </div>
    </div>
  );
}
