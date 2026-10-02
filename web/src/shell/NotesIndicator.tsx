import { Link } from "react-router-dom";
import { Bell } from "lucide-react";
import { useSession } from "@/api/queries";
import { useAckNotes } from "@/api/mutations";
import "./account.css";

/** A bell with the number of watchman notes nobody has read; opening them marks them read. */
export function NotesIndicator() {
  const { data } = useSession();
  const ack = useAckNotes({ quiet: true });
  const n = data?.notes.length ?? 0;
  if (n === 0) return null;
  return (
    <Link to="/activity?tab=notes" className="topbar__icon-btn topbar__notes" aria-label={`${n} unread watchman ${n === 1 ? "note" : "notes"}`} onClick={() => ack.mutate()}>
      <Bell size={18} aria-hidden="true" />
      <span className="topbar__badge" aria-hidden="true">
        {n > 9 ? "9+" : n}
      </span>
    </Link>
  );
}
