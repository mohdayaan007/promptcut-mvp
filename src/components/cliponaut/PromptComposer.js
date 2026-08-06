import { ArrowUpIcon } from "@/components/cliponaut/icons";

export function PromptComposer({
  inputRef,
  prompt,
  onPromptChange,
  onSubmit,
  isProcessing = false,
  canGenerate = false,
  compact = false,
}) {
  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && onSubmit) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={`cliponaut-composer ${compact ? "is-compact" : ""}`}>
      <textarea
        ref={inputRef}
        aria-label="Describe your video edit"
        placeholder="Describe how you'd like to edit your video..."
        rows={compact ? 2 : 3}
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button
        className="cliponaut-generate"
        type="button"
        onClick={onSubmit}
        disabled={!canGenerate || isProcessing}
      >
        {isProcessing ? "Generating" : "Generate"}
        <ArrowUpIcon />
      </button>
    </div>
  );
}
