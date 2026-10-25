import type { ButtonHTMLAttributes } from "react";

// The one button. 32px by default (28px small), 8px radius, sentence-case
// labels. Primary is ink on the page — the accent is kept for focus and links,
// so a screen has one obvious next step rather than a row of coloured ones.

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-ink enabled:hover:opacity-90",
  secondary: "border border-line bg-surface text-ink enabled:hover:bg-subtle",
  ghost: "text-muted enabled:hover:bg-subtle enabled:hover:text-ink",
  danger: "border border-line bg-surface text-bad enabled:hover:bg-bad-soft",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px]",
  md: "h-8 px-3 text-[13px]",
};

/** The classes for a button — also for a link that should look like one. */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra = ""): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`.trim();
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}
