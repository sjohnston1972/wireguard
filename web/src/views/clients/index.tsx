import { useParams } from "react-router-dom";
import { Placeholder } from "../Placeholder";

// Plan 4 area C replaces this file with the Clients view (the detail route opens its side panel).
export const ClientsPage = () => <Placeholder title="Clients" />;
export const ClientDetailPage = () => <Placeholder title={`Client ${useParams().id}`} />;
