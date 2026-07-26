import { createContext, useContext } from 'react'
import type { PitchMapping } from './pitchMapping'

export const PitchMappingContext = createContext<PitchMapping | null>(null)

export function usePitchMapping(): PitchMapping {
  const m = useContext(PitchMappingContext)
  if (!m) throw new Error('usePitchMapping must be used within a PitchCanvas')
  return m
}
