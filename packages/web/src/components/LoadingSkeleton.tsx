/** Quiet neutral placeholder lines paired with a status sentence while a
 * session or conversation is being read from the server. */
export function LoadingSkeleton({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      className={
        className ? `loading-skeleton ${className}` : "loading-skeleton"
      }
      role="status"
    >
      <div className="loading-skeleton-lines" aria-hidden="true">
        <span className="loading-skeleton-line wide" />
        <span className="loading-skeleton-line mid" />
        <span className="loading-skeleton-line short" />
      </div>
      <p className="loading-skeleton-label">{label}</p>
    </div>
  );
}
