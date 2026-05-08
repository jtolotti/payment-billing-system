import * as React from 'react'
import { cn } from './utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[80px] w-full rounded-lg border px-3 py-2 text-sm',
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
Textarea.displayName = 'Textarea'
