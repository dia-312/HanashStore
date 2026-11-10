// Small line icons drawn here (SPEC: all art is made in code), so the app needs no icon library.
// 24x24, stroke only; a dot is a zero-length line with round caps. They are decoration: the word
// next to every icon says the same thing, so they are hidden from screen readers.

const PATHS = {
  building:
    'M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h3M8 12h3M8 16h3',
  tag: 'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9zM7.5 7.5h.01',
  words: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3M8 10h6M8 13h6',
  import: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  export: 'M12 15V3M7 8l5-5 5 5M4 21h16',
  sync: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5',
  image:
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 9h.01M21 15l-5-5L5 21',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  pin: 'M6 6h.01M12 6h.01M18 6h.01M6 12h.01M12 12h.01M18 12h.01M6 18h.01M12 18h.01M18 18h.01',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  devices: 'M3 5h14v10H3zM7 19h6M19 8l4 4m0-4-4 4',
  disk: 'M3 14h18v6H3zM3 14l3-9h12l3 9M7 17h.01',
  gauge: 'M12 14l4-4M3.3 18a10 10 0 1 1 17.4 0',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 16v-4M12 8h.01',
  tablet: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  zoom: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3M11 8v6M8 11h6',
  chat: 'M21 12a8 8 0 0 1-11.9 7L3 21l2-5.5A8 8 0 1 1 21 12z',
  mail: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 7l9 6 9-6',
  // Points to the left: the way forward in a right-to-left page.
  forward: 'M15 18l-6-6 6-6',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, className = 'size-6' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
