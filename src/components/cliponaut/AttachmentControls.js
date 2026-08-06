import { ImageIcon, VideoIcon } from "@/components/cliponaut/icons";

export function AttachmentControls({ onSelectVideo, onSelectImages, imageCount = 0 }) {
  return (
    <div className="cliponaut-attachments" aria-label="Media attachment options">
      <button className="cliponaut-attachment" type="button" onClick={onSelectVideo}>
        <VideoIcon />
        <span>Upload Video</span>
      </button>
      <button className="cliponaut-attachment" type="button" onClick={onSelectImages}>
        <ImageIcon />
        <span>{imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"} added` : "Add Images"}</span>
        {!imageCount && <span className="cliponaut-attachment-optional">optional</span>}
      </button>
    </div>
  );
}
