export interface ApiErrorBody {
  code: string
  message: string
  details: Record<string, unknown>
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

/** Signed difference (server minus device) in ms, from the last X-Server-Time header; null until seen. */
let clockSkewMs: number | null = null
export const getClockSkewMs = () => clockSkewMs

export async function api<T = void>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET'
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'app', // required on writes by the server (CSRF)
        // A FormData body sets its own multipart Content-Type (with the boundary).
        ...(options.body === undefined || options.body instanceof FormData
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      body:
        options.body === undefined
          ? undefined
          : options.body instanceof FormData
            ? options.body
            : JSON.stringify(options.body),
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'No connection')
  }
  const serverTime = response.headers.get('X-Server-Time')
  if (serverTime) clockSkewMs = Date.parse(serverTime) - Date.now()
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null
    throw new ApiError(
      response.status,
      body?.code ?? 'HTTP_ERROR',
      body?.message ?? response.statusText,
      body?.details ?? {},
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}
