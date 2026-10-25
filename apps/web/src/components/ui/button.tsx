import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

// Gotchu buttons: 8px corners, 34px tall on mobile and 48px from md up. Focus changes the border;
// hover shifts filled buttons up-left over a hard 4px magenta offset.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent font-sans font-semibold whitespace-nowrap no-underline select-none transition-[translate,scale,box-shadow,background-color,border-color,color,text-decoration-color] duration-160 ease-[cubic-bezier(.23,1,.32,1)] focus-visible:border-brand-ink active:not-aria-[haspopup]:scale-[.97] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-160 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_var(--brand)] hover:[&_svg]:translate-x-1",
        outline:
          "border-border bg-background text-foreground hover:border-foreground hover:bg-muted aria-expanded:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_var(--brand)]",
        ghost:
          "text-foreground hover:bg-muted aria-expanded:bg-muted",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20",
        link: "h-auto! rounded-sm px-0! font-semibold text-foreground underline decoration-foreground decoration-2 underline-offset-[.28em] hover:text-brand-ink hover:decoration-brand hover:[&_svg]:translate-x-1",
      },
      size: {
        default: "h-[34px] gap-2 px-4 text-[14.5px] md:h-12 md:gap-2.5 md:px-[22px] md:text-base",
        sm: "h-[34px] gap-1.5 px-4 text-[14.5px]",
        lg: "h-[34px] gap-2 px-4 text-[14.5px] md:h-14 md:gap-2.5 md:px-7 md:text-[17px]",
        icon: "size-[34px]",
        "icon-sm": "size-[34px] [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
