// Arabic text normalization (SPEC section 9). The Python copy is apps/api/app/normalize.py; both are
// tested against shared/normalize_cases.json so they can't drift.

const FOLDS: Record<string, string> = {
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ة: 'ه',
  ى: 'ي',
  ؤ: 'و',
  ئ: 'ي',
}

export function normalizeArabic(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[ً-ٰٟـ]/g, '')
      .replace(/[أإآٱةىؤئ]/g, (c) => FOLDS[c] ?? c)
      .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
      // Anything that is not a letter or a number is punctuation or space: one space each, collapsed.
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  )
}
