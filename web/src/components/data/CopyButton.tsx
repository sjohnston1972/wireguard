import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "../forms/IconButton";

export interface CopyButtonProps {
  text: string;
  /** Accessible name, for example "Copy public key". */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}

/** Copies text; the icon turns into a tick and "Copied" is announced politely. */
export function CopyButton({ text, label = "Copy", size = "sm", className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <IconButton label={label} size={size} variant="plain" className={className} onClick={copy}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </IconButton>
      <span className="visually-hidden" role="status">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}
