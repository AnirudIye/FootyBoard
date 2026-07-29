import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme/fonts'
import './index.css'
import { applyTeamTokens } from './theme/teamColors'
import App from './App'

// The other half of the team pair, and it has to be landed here or the feature
// ships dark: `tokens.css` no longer declares --home or --away, because a canvas
// cannot read a custom property and the definition therefore lives in
// TypeScript. This publishes it to :root before anything renders, so the
// `bg-home` legend dot and the chip it labels cannot disagree.
applyTeamTokens()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
