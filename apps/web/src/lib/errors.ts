import { fill, ar } from '../i18n/ar'
import { ApiError } from './api'

/** Server error codes (apps/api) to a message the rep can act on. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return ar.errors.generic
  const e = ar.errors
  switch (error.code) {
    case 'NETWORK':
      return e.network
    case 'INSUFFICIENT_STOCK':
      return fill(e.insufficientStock, { available: Number(error.details.available ?? 0) })
    case 'DUPLICATE_VARIANT':
      return e.duplicateVariant
    case 'DUPLICATE_CATEGORY':
      return e.duplicateCategory
    case 'NO_DIFFERENCE':
      return e.noDifference
    case 'IMAGE_TOO_LARGE':
      return e.imageTooLarge
    case 'IMAGE_UNSUPPORTED':
      return e.imageUnsupported
    case 'IMAGE_TOO_BIG_PIXELS':
      return e.imagePixels
    case 'TOO_MANY_IMAGES':
      return e.tooManyImages
    case 'VARIANT_INACTIVE':
      return e.variantInactive
    case 'VALIDATION_ERROR':
      return e.validation
    case 'NOT_FOUND':
      return e.notFound
    case 'IMPORT_EMPTY':
      return e.importEmpty
    case 'IMPORT_UNREADABLE':
      return e.importUnreadable
    case 'IMPORT_OLD_EXCEL':
      return e.importOldExcel
    case 'IMPORT_TOO_LARGE':
      return e.importTooLarge
    case 'IMPORT_TOO_MANY_ROWS':
      return e.importTooMany
    default:
      return e.generic
  }
}
