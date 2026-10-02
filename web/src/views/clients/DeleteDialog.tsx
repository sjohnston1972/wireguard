import { useDeleteClient } from "@/api/mutations";
import { ConfirmByTyping, Modal } from "@/components";
import type { Client } from "./model";

/** Delete a client, confirmed by typing its name. Its config stops working at the next heartbeat. */
export function DeleteDialog({ client, onClose, onDeleted }: { client: Client; onClose: () => void; onDeleted: () => void }) {
  const del = useDeleteClient();
  return (
    <Modal
      open
      onOpenChange={(o) => !o && !del.isPending && onClose()}
      title={`Delete ${client.name}?`}
      description="Its config stops working at the next heartbeat. This cannot be undone: to bring the device back, add it again."
    >
      <ConfirmByTyping phrase={client.name} actionLabel="Delete client" pending={del.isPending} onConfirm={() => del.mutate(client.id, { onSuccess: onDeleted })} />
    </Modal>
  );
}
