import type { ClientsResponse } from "@shared/api";
import type { Client } from "./model";
import type { ClientHandlers } from "./ClientsScreen";

export function ClientPanel(_: { id: number; client: Client | null; data: ClientsResponse; h: ClientHandlers }) {
  return null;
}
