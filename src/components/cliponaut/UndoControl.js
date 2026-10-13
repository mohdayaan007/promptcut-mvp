import { UndoIcon } from "@/components/cliponaut/icons";

const TOOLTIP = "Undo restores your previous successful edit. After you use it, Undo resets until your next edit.";

export function UndoControl({ canUndo, isDisabled, isUndoing, onUndo }) {
  return (
    <span className="cliponaut-undo-tooltip" tabIndex="0" data-tooltip={TOOLTIP}>
      <button className="cliponaut-undo-button is-icon-only" type="button" onClick={onUndo} disabled={!canUndo || isDisabled} aria-label="Undo">
        <UndoIcon />
        <span className="cliponaut-visually-hidden">{isUndoing ? "Restoring previous edit" : "Undo"}</span>
      </button>
    </span>
  );
}
