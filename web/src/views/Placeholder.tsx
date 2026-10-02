import { PageHeader } from "@/components/layout/PageHeader";
import { EnvironmentField } from "@/shell/StateChip";
import "./Placeholder.css";

/** Stand-in for a view that plan 4 builds: its header (title, the read-only environment) and nothing else. */
export function Placeholder({ title }: { title: string }) {
  return (
    <section className="placeholder">
      <PageHeader title={title} subtitle="Built in plan 4" env={<EnvironmentField />} />
    </section>
  );
}
