import { balanceView } from '../lib/balance'

const SHAPE = { owes: '▲', credit: '▼', clear: '○' } as const
const TONE = {
  owes: 'text-red-800',
  credit: 'text-green-800',
  clear: 'text-navy',
} as const

/** A balance with its own shape and words, so it never relies on colour: ▲ owes, ▼ credit. */
export function Balance({ agorot, big = false }: { agorot: number; big?: boolean }) {
  const { kind, text } = balanceView(agorot)
  return (
    <span className={`font-bold ${TONE[kind]} ${big ? 'text-3xl' : ''}`}>
      <span aria-hidden="true">{SHAPE[kind]} </span>
      <bdi>{text}</bdi>
    </span>
  )
}
