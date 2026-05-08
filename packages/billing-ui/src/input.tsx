import * as React from 'react'
import { cn } from './utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <input
        className={cn(
          'flex h-10 w-full rounded-lg border px-3 py-2 text-sm',
          'bg-white text-neutral-900',
          'placeholder:text-neutral-400',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:border-blue-500',
          'disabled:cursor-not-allowed disabled:opacity-50',
          error ? 'border-red-500 focus-visible:ring-red-500' : 'border-neutral-300',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'
