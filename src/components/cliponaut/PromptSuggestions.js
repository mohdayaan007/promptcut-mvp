const suggestions = [
  "Make it cinematic",
  "Trim from 0:05 to 0:10",
  "Add title Summer",
  "Merge these videos",
];

export function PromptSuggestions({ onSelect, className = "" }) {
  return (
    <div className={`cliponaut-suggestions ${className}`} aria-label="Example edit prompts">
      {suggestions.map((suggestion) => (
        <button
          className="cliponaut-suggestion"
          key={suggestion}
          type="button"
          onClick={() => onSelect(suggestion)}
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}
