/**
 * Thin API client. Every request sends `x-user-id` pulled from localStorage
 * (set by the dev user switcher on the landing page).
 *
 * Real production clients would use a real auth library. This is deliberately
 * minimal so the candidate's time goes to billing logic, not identity plumbing.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'

function getUserId(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem('x-user-id')
}

export function setUserId(userId: string) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem('x-user-id', userId)
}

export function clearUserId() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem('x-user-id')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const userId = getUserId()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (userId) headers['x-user-id'] = userId

  const res = await fetch(`${API_URL}${path}`, { ...init, headers, cache: 'no-store' })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}
