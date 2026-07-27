import PitchCanvas from './PitchCanvas'
import Toolbar from './Toolbar'
import DrawingToolbar from './DrawingToolbar'
import FrameStrip from './FrameStrip'
import BenchRail from './BenchRail'
import Inspector from './Inspector'
import Toasts from './Toasts'
import HUD from './HUD'
import Assistant from './Assistant'
import { useKeyboard } from '../../hooks/useKeyboard'
import { useAutosave } from '../../hooks/useAutosave'
import { usePlayback } from '../../hooks/usePlayback'
import { useRealtime } from '../../hooks/useRealtime'
import { useShareLink } from '../../hooks/useShareLink'

export default function BoardPage() {
  // A `?share=` link is redeemed before anything else, so the board it names is
  // the one that opens rather than whichever was open last.
  useShareLink()
  useAutosave()
  useRealtime()
  useKeyboard()
  usePlayback()

  // A column, not a stack of floating bars at hand-measured offsets. The top
  // bar wraps to a second row at narrow widths and the frame strip grows when
  // frames are captured, so any fixed inset between them was a guess that came
  // apart: the HUD ended up underneath a wrapped toolbar. Here the middle band
  // is whatever is left over, and nothing inside it can reach the chrome.
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-paper">
      <Toolbar />

      <div className="relative flex-1 overflow-hidden">
        <PitchCanvas />
        <BenchRail side="home" />
        <BenchRail side="away" />
        <HUD />
        <DrawingToolbar />
      </div>

      <FrameStrip />

      <Inspector />
      <Assistant />
      <Toasts />
    </div>
  )
}
