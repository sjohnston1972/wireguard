import { LogIn } from "lucide-react";
import "./status.css";

/** Shown in place of the page when Cloudflare Access says the sign-in has lapsed. */
export function SessionExpiredScreen() {
  return (
    <div className="session-expired">
      <LogIn size={28} aria-hidden="true" />
      <h1 className="session-expired__title">Session expired, sign in again</h1>
      <p className="session-expired__text">Your Cloudflare Access sign-in has run out. Nothing you changed is lost on the server.</p>
      <button type="button" className="session-expired__btn" onClick={() => window.location.reload()}>
        Sign in
      </button>
    </div>
  );
}
