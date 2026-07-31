import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme/fonts'
import './index.css'
import { applyTeamTokens } from './theme/teamColors'
import { applyTheme, readThemePreference } from './theme/theme'
import App from './App'

// Before the first render, and for the same reason the team pair is: a palette
// chosen after React has painted is a page that flashes the other one first.
// This writes the `data-theme` attribute the light rules in `tokens.css` hang
// off, so the very first paint is already the right palette.
applyTheme(readThemePreference())

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
