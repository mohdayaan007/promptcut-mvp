import { AttachmentControls } from "@/components/cliponaut/AttachmentControls";
import { PromptComposer } from "@/components/cliponaut/PromptComposer";

const suggestions = [
  "Make it cinematic",
  "Trim from 0:05 to 0:10",
  "Add title Summer",
  "Merge these videos",
];

export function EmptyEditorState({
  prompt,
  onPromptChange,
  onSelectVideo,
  onSelectImages,
  onSelectSuggestion,
  imageCount,
}) {
  return (
    <section className="cliponaut-empty-state" aria-labelledby="editor-heading">
      <div className="cliponaut-hero-copy">
        <p className="cliponaut-eyebrow">AI-powered Video Editing</p>
        <h1 id="editor-heading">What would you like to edit?</h1>
        <p className="cliponaut-intro">
          Upload your clips, describe your edit, and let AI handle the rest.
        </p>
      </div>

      <div className="cliponaut-composer-area">
        <AttachmentControls
          onSelectVideo={onSelectVideo}
          onSelectImages={onSelectImages}
          imageCount={imageCount}
        />
        <div className="cliponaut-suggestions" aria-label="Example edit prompts">
          {suggestions.map((suggestion) => (
            <button
              className="cliponaut-suggestion"
              key={suggestion}
              type="button"
              onClick={() => onSelectSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
        <PromptComposer prompt={prompt} onPromptChange={onPromptChange} />
        <p className="cliponaut-composer-note">Upload a video to start editing. Short clips work best.</p>
      </div>
    </section>
  );
}
