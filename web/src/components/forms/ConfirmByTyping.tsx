import { useId, useState } from "react";
import { Button } from "./Button";
import "./Field.css";
import "./ConfirmByTyping.css";

export interface ConfirmByTypingProps {
  /** The exact text the user must type. */
  phrase: string;
  actionLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  variant?: "danger" | "primary";
}

/** Destructive actions: the confirm button stays disabled until the phrase is typed. */
export function ConfirmByTyping({ phrase, actionLabel, onConfirm, pending, variant = "danger" }: ConfirmByTypingProps) {
  const id = useId();
  const [text, setText] = useState("");
  const ok = text.trim() === phrase;
  return (
    <div className="confirm-typing">
      <label htmlFor={id} className="field__label">
        Type {phrase} to confirm
      </label>
      <input
        id={id}
        className="input"
        value={text}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      <Button variant={variant} disabled={!ok || pending} loading={pending} onClick={onConfirm}>
        {actionLabel}
      </Button>
    </div>
  );
}
