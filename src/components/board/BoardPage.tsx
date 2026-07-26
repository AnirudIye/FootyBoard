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

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-paper">
      <PitchCanvas />

      <Toolbar />
      <DrawingToolbar />
      <FrameStrip />
      <BenchRail side="home" />
      <BenchRail side="away" />
      <HUD />

      <Inspector />
      <Assistant />
      <Toasts />
    </div>
  )
}
