export type Side = 'home' | 'away'

export interface Team {
  id: string
  name: string
  color: string
  side: Side
}

export type TokenType =
  | 'player'
  | 'ball'
  | 'cone'
  | 'pole'
  | 'goal'
  | 'mannequin'
  | 'arrowMarker'

export type TokenShape = 'outfield' | 'keeper'

export interface Token {
  id: string
  type: TokenType
  teamId?: string // players only
  number?: number // players
  label?: string // optional name
  color: string
  shape?: TokenShape // players
  x: number // normalized pitch coordinate 0..100
  y: number // normalized pitch coordinate 0..100
  rotation: number // body orientation, degrees
}

export type DrawingType =
  | 'pen'
  | 'line'
  | 'arrow'
  | 'dashedArrow'
  | 'curveArrow'
  | 'curvePass'
  | 'zoneRect'
  | 'zoneEllipse'
  | 'zonePoly'
  | 'text'

export interface Drawing {
  id: string
  type: DrawingType
  points: number[] // geometry, meaning depends on type
  control?: number[] // curve control point
  color: string
  thickness: number
  dashed?: boolean
  fillOpacity?: number // zones
  text?: string // text box
  attachedTokenId?: string // moves with a token when set
}

export interface FrameTokenState {
  x: number
  y: number
  rotation: number
}

export interface Frame {
  id: string
  label: string
  tokens: Record<string, FrameTokenState>
}

export type PitchView = 'fullH' | 'fullV' | 'attackHalf' | 'defendHalf' | 'blank'
export type PitchKind = '11' | '7aside' | 'futsal'

export interface ViewSettings {
  view: PitchView
  kind: PitchKind
  grass: boolean
  lineColor: string
  overlayGrid: boolean
  pitchTheme: 'dark' | 'light'
  snap: boolean
}

export interface CustomFormation {
  id: string
  name: string
  positions: { x: number; y: number }[]
  kind: PitchKind
}
