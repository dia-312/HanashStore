// Fails when the JavaScript the app shell loads at startup exceeds the budget (SPEC section 17).
// "Initial" = the scripts and modulepreloads that dist/index.html references, gzipped.
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const BUDGET = 250 * 1024
const html = readFileSync('dist/index.html', 'utf8')
const files = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1])
if (files.length === 0) {
  console.error('No script found in dist/index.html. Run the build first.')
  process.exit(1)
}

let total = 0
for (const f of new Set(files)) {
  const size = gzipSync(readFileSync('dist' + f)).length
  total += size
  console.log(`${(size / 1024).toFixed(1).padStart(7)} KB  ${f}`)
}
console.log(
  `${(total / 1024).toFixed(1).padStart(7)} KB  initial JS (gzip), budget ${BUDGET / 1024} KB`,
)
if (total > BUDGET) {
  console.error('Initial JavaScript is over budget.')
  process.exit(1)
}
