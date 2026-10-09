/** Keep both localized labels in layout while exposing only the current one. */
export function ActionLabel({
  idle,
  busy,
  pending,
}: {
  idle: string;
  busy: string;
  pending: boolean;
}) {
  return (
    <span className="action-label">
      <span aria-hidden={pending} className={pending ? "action-label-hidden" : undefined}>
        {idle}
      </span>
      <span
        aria-hidden={!pending}
        className={pending ? "working-text working-text-strong" : "action-label-hidden"}
      >
        {busy}
      </span>
    </span>
  );
}
