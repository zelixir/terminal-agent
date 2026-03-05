import * as React from "react"
import { cn } from "../../lib/utils"

/** Inline code span */
export const Code = React.forwardRef<
  HTMLElement,
  React.HTMLAttributes<HTMLElement>
>(({ className, ...props }, ref) => (
  <code
    ref={ref}
    className={cn(
      "relative rounded bg-gray-800 px-[0.3rem] py-[0.1rem] font-mono text-sm text-green-300",
      className
    )}
    {...props}
  />
))
Code.displayName = "Code"

/** Block of pre-formatted code / terminal output */
export const CodeBlock = React.forwardRef<
  HTMLPreElement,
  React.HTMLAttributes<HTMLPreElement>
>(({ className, ...props }, ref) => (
  <pre
    ref={ref}
    className={cn(
      "rounded-lg border border-gray-700 bg-gray-950 p-3 font-mono text-xs text-gray-300",
      "overflow-x-auto whitespace-pre-wrap break-all",
      className
    )}
    {...props}
  />
))
CodeBlock.displayName = "CodeBlock"
