import { AttachmentControls } from "@/components/cliponaut/AttachmentControls";
import { PromptComposer } from "@/components/cliponaut/PromptComposer";
import { PromptSuggestions } from "@/components/cliponaut/PromptSuggestions";

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
        <p className="cliponaut-eyebrow">ChatGPT for video editing</p>
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
        <PromptSuggestions onSelect={onSelectSuggestion} />
        <PromptComposer prompt={prompt} onPromptChange={onPromptChange} />
        <p className="cliponaut-composer-note">Upload a video to start editing. Short clips work best.</p>
      </div>
    </section>
  );
}
