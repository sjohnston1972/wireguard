import { useParams } from "react-router-dom";
import { Placeholder } from "../Placeholder";

// Plan 4 area D replaces this file with the Firewall view (the rule route opens its drawer).
export const FirewallPage = () => <Placeholder title="Firewall" />;
export const FirewallRulePage = () => <Placeholder title={`Firewall rule ${useParams().id}`} />;
