import { ImageIcon, VideoIcon } from "@/components/cliponaut/icons";

export function AttachmentControls({ onSelectVideo, onSelectImages, imageCount = 0, disabled = false }) {
  return (
    <div className="cliponaut-attachments" aria-label="Media attachment options">
      <button className="cliponaut-attachment" type="button" onClick={onSelectVideo} disabled={disabled}>
        <VideoIcon />
        <span>Upload Video</span>
      </button>
      <button className="cliponaut-attachment" type="button" onClick={onSelectImages} disabled={disabled}>
        <ImageIcon />
        <span>{imageCount ? "Style reference added" : "Add Style Reference"}</span>
        {!imageCount && <span className="cliponaut-attachment-optional">optional</span>}
      </button>
    </div>
  );
}
