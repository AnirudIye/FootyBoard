export interface History<T> {
  past: T[]
  future: T[]
}

export const createHistory = <T>(): History<T> => ({ past: [], future: [] })

export function push<T>(h: History<T>, snapshot: T, cap = 50): History<T> {
  const past = [...h.past, snapshot].slice(-cap)
  return { past, future: [] }
}

export function undo<T>(h: History<T>, present: T) {
  if (h.past.length === 0) return null
  const prev = h.past[h.past.length - 1]
  return {
    history: { past: h.past.slice(0, -1), future: [present, ...h.future] },
    present: prev,
  }
}

export function redo<T>(h: History<T>, present: T) {
  if (h.future.length === 0) return null
  const next = h.future[0]
  return {
    history: { past: [...h.past, present], future: h.future.slice(1) },
    present: next,
  }
}
