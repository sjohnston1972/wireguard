import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Plus, Settings2, Users } from "lucide-react";
import { useClients, useOverview } from "@/api/queries";
import { useEditClient } from "@/api/mutations";
import { DEMO_ACTIONS_OFF, useDemoOn } from "@/api/demo";
import { Button, EmptyState, ErrorState, IconButton, PageHeader, Panel, Skeleton, useIsPhone, type RowAction } from "@/components";
import { EnvironmentField, regionLabel } from "@/shell/StateChip";
import { LayoutMenu, Widget } from "@/widgets";
import type { Client } from "./model";
import { ClientsDesktop } from "./ClientsDesktop";
import { ClientsPhone } from "./ClientsPhone";
import { AddClientWizard } from "./AddClientWizard";
import { RekeyDialog } from "./RekeyDialog";
import { DeleteDialog } from "./DeleteDialog";
import "./ClientsScreen.css";

/** The read-only Region beside the environment (one deployment region, changed in Settings). */
export function RegionField() {
  const o = useOverview();
  const label = regionLabel(o.data?.snapshot?.region ?? o.data?.config?.region) ?? "no data";
  return (
    <div className="ro-field" role="group" aria-label="Region">
      <span className="ro-field__caption" aria-hidden>
        Region
      </span>
      <span className="ro-field__value">{label}</span>
    </div>
  );
}

/** What the page's dialogs are doing: nothing, adding, a re-key or a delete for one client. */
type Dialog = { kind: "none" } | { kind: "add" } | { kind: "rekey"; client: Client } | { kind: "delete"; client: Client };

/**
 * The Clients view (and /clients/:id, which opens the client's panel beside
 * it). Desktop: header, count tiles, filters, table, lower row, split panel.
 * Phone: one line per client, details in a sheet.
 */
export function ClientsScreen() {
  const q = useClients();
  const phone = useIsPhone();
  const navigate = useNavigate();
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  // /clients/:id opens that client; an id that is not a number opens "No such client".
  const rawId = params.id ?? null;
  const selectedId = rawId !== null && /^\d+$/.test(rawId) ? Number(rawId) : rawId !== null ? -1 : null;
  const data = q.data;
  const edit = useEditClient();

  // ?action=add (the command palette) opens the wizard once per appearance of
  // the parameter, also when the page is already open; closing it drops the parameter.
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const asked = search.get("action");
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (asked !== "add") {
      handled.current = null;
      return;
    }
    if (handled.current === asked) return;
    handled.current = asked;
    setDialog({ kind: "add" });
  }, [asked]);
  const close = useCallback(() => {
    setDialog({ kind: "none" });
    if (search.has("action")) {
      const next = new URLSearchParams(search);
      next.delete("action");
      setSearch(next, { replace: true });
    }
  }, [search, setSearch]);

  const open = useCallback((c: Client) => navigate(`/clients/${c.id}`), [navigate]);
  const closePanel = useCallback(() => navigate("/clients"), [navigate]);
  const startAdd = useCallback(() => setDialog({ kind: "add" }), []);
  // Demo mode (spec ruling 18): Add client is off, saying why on hover.
  const demo = useDemoOn();
  const rekey = useCallback((c: Client) => setDialog({ kind: "rekey", client: c }), []);
  const remove = useCallback((c: Client) => setDialog({ kind: "delete", client: c }), []);
  const toggleEnabled = useCallback((c: Client) => edit.mutate({ id: c.id, enabled: !c.enabled }), [edit]);

  const actions = useCallback(
    // The home site is managed by `npm run home`: enable/disable only (spec 8.2).
    (c: Client): RowAction[] => [
      { label: "Open details", onSelect: () => open(c) },
      ...(c.isSite ? [] : [{ label: "Get new config", onSelect: () => rekey(c) }]),
      { label: c.enabled ? "Disable" : "Enable", onSelect: () => toggleEnabled(c) },
      ...(c.isSite ? [] : [{ label: "Delete", danger: true, onSelect: () => remove(c) }]),
    ],
    [open, rekey, toggleEnabled, remove],
  );

  const handlers = useMemo(
    () => ({ open, closePanel, startAdd, rekey, remove, toggleEnabled, actions, togglePending: edit.isPending }),
    [open, closePanel, startAdd, rekey, remove, toggleEnabled, actions, edit.isPending],
  );

  const header = (
    <PageHeader
      title="Clients"
      subtitle={phone ? undefined : "Manage WireGuard clients, view connection status, and configure access."}
      env={phone ? undefined : <EnvironmentField />}
      right={
        <>
          {!phone && <RegionField />}
          {!phone && (
            <IconButton label="Network settings" onClick={() => navigate("/settings/deployment")}>
              <Settings2 size={17} aria-hidden />
            </IconButton>
          )}
          <LayoutMenu page="clients" />
          <Button variant="primary" icon={<Plus size={16} aria-hidden />} onClick={startAdd} size={phone ? "md" : "lg"} disabled={demo} title={demo ? DEMO_ACTIONS_OFF : undefined}>
            Add client
          </Button>
        </>
      }
    />
  );

  let body;
  if (q.isPending) body = <ClientsSkeleton />;
  else if (q.isError)
    body = (
      <Widget id="clients.table" headerless>
        <Panel className="clients__state">
          <ErrorState title="Could not load the clients" message={q.error.message} onRetry={() => void q.refetch()} />
        </Panel>
      </Widget>
    );
  else if (data!.clients.length === 0)
    body = (
      <Widget id="clients.table" headerless>
        <Panel className="clients__state">
          <EmptyState
            icon={<Users size={22} />}
            title="No clients yet"
            description="Add a device: its keys are made in this browser, and you get a QR code and a .conf file."
            action={{ label: "Add client", onClick: startAdd }}
          />
        </Panel>
      </Widget>
    );
  else if (phone) body = <ClientsPhone data={data!} selectedId={selectedId} rawId={rawId} h={handlers} />;
  else body = <ClientsDesktop data={data!} selectedId={selectedId} rawId={rawId} h={handlers} />;

  return (
    <section className="clients" aria-label="Clients">
      {header}
      {body}
      {dialog.kind === "add" && data && <AddClientWizard config={data.config} onClose={close} />}
      {dialog.kind === "rekey" && <RekeyDialog client={dialog.client} onClose={close} />}
      {dialog.kind === "delete" && (
        <DeleteDialog
          client={dialog.client}
          onClose={close}
          onDeleted={() => {
            close();
            if (selectedId === dialog.client.id) closePanel();
          }}
        />
      )}
    </section>
  );
}

export type ClientHandlers = {
  open: (c: Client) => void;
  closePanel: () => void;
  startAdd: () => void;
  rekey: (c: Client) => void;
  remove: (c: Client) => void;
  toggleEnabled: (c: Client) => void;
  actions: (c: Client) => RowAction[];
  togglePending: boolean;
};

/** Loading: the page's shape (six tiles, a toolbar, table rows, the lower row). */
function ClientsSkeleton() {
  return (
    <div className="clients__skeleton" aria-busy="true" aria-label="Loading clients">
      <div className="clients__skel-tiles">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} variant="tile" />
        ))}
      </div>
      <Skeleton variant="line" width="40%" />
      <Widget id="clients.table" headerless>
        <Panel className="clients__skel-table">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} variant="row" />
          ))}
        </Panel>
      </Widget>
    </div>
  );
}
