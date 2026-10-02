import type { ClientsResponse } from "@shared/api";
import type { ClientHandlers } from "./ClientsScreen";

export function ClientsPhone(_: { data: ClientsResponse; selectedId: number | null; h: ClientHandlers }) {
  return null;
}
