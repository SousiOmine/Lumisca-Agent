/** Render image content blocks (base64 `data`) as clickable thumbnails.
 * Shared by user messages and tool results. */
export function ContentImages({
  images,
}: {
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}) {
  return (
    <div className="msg-images">
      {images.map((image, index) => (
        <img
          key={index}
          className="msg-image"
          src={`data:${image.mimeType};base64,${image.data}`}
          alt=""
        />
      ))}
    </div>
  );
}
