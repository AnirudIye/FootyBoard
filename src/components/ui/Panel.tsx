import type { HTMLAttributes } from 'react'

export function Panel({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`bg-surface border border-rule rounded shadow-2 ${className}`}
    />
  )
}
