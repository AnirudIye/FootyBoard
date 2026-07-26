import { useReducedMotion } from '../../hooks/useReducedMotion'

/**
 * The hero ground: a pitch grid receding into black under two floodlight
 * pools. The grid is the pitch's own geometry rather than a generic tech
 * mesh, and the light drifts slowly so the section breathes without asking
 * for attention. Pure CSS — nothing to schedule, nothing to clean up.
 */
export default function FloodlitBackdrop() {
  const reduced = useReducedMotion()

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Floodlight pools: wrapper places them, inner element breathes. */}
      <div className="absolute -top-1/3 left-1/2 h-[46rem] w-[46rem] -translate-x-1/2">
        <div
          className={`h-full w-full rounded-full blur-[120px] ${
            reduced ? '' : 'animate-[flood_14s_ease-in-out_infinite]'
          }`}
          style={{ background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 68%)' }}
        />
      </div>
      <div className="absolute -bottom-1/4 right-[-10%] h-[34rem] w-[34rem]">
        <div
          className={`h-full w-full rounded-full blur-[130px] ${
            reduced ? '' : 'animate-[flood_18s_ease-in-out_infinite_reverse]'
          }`}
          style={{ background: 'radial-gradient(circle, rgba(42,224,122,0.16) 0%, transparent 70%)' }}
        />
      </div>

      {/* Pitch grid, fading out as it recedes */}
      <div
        className="absolute inset-x-0 bottom-0 h-[60%] opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(42,224,122,0.16) 1px, transparent 1px),' +
            'linear-gradient(90deg, rgba(42,224,122,0.16) 1px, transparent 1px)',
          backgroundSize: '68px 68px',
          maskImage: 'linear-gradient(to top, black, transparent)',
          WebkitMaskImage: 'linear-gradient(to top, black, transparent)',
        }}
      />

      {/* Grain keeps the large flat blacks from banding */}
      <div
        className="absolute inset-0 opacity-[0.05] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
    </div>
  )
}
