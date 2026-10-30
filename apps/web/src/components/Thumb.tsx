/** Product picture in a fixed square box, so lists never jump while images load (SPEC section 17). */
export function Thumb({ url, className = '' }: { url: string | null; className?: string }) {
  return (
    <div className={`aspect-square overflow-hidden bg-navy/5 ${className}`}>
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
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
