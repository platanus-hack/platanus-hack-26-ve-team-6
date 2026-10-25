"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

// 34px controls with 8px corners; the pressed state reads as an ink fill, not a soft tint.
const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-lg border border-transparent text-sm font-semibold whitespace-nowrap text-muted-foreground transition-[background-color,border-color,color] duration-160 ease-[cubic-bezier(.23,1,.32,1)] hover:text-foreground focus-visible:border-brand-ink disabled:pointer-events-none disabled:opacity-50 data-pressed:bg-foreground data-pressed:text-background [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-border bg-transparent hover:border-foreground",
      },
      size: {
        default: "h-[34px] min-w-[34px] px-2.5",
        lg: "h-12 min-w-12 px-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
