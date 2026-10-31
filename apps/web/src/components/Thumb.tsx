/** Product picture in a fixed square box, so lists never jump while images load (SPEC section 17). */
export function Thumb({
  url,
  className = '',
  eager = false,
}: {
  url: string | null
  className?: string
  /** Load at once: for lists that already draw only what is on screen (virtualized). */
  eager?: boolean
}) {
  return (
    <div className={`aspect-square overflow-hidden bg-navy/5 ${className}`}>
      {url ? (
        <img
          src={url}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          className="size-full object-cover"
          draggable={false}
        />
      ) : (
        <span aria-hidden="true" className="grid size-full place-items-center text-3xl opacity-30">
          ▣
        </span>
      )}
    </div>
  )
}
