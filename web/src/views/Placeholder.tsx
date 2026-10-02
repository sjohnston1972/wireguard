import "./Placeholder.css";

/** Stand-in for a view that plan 4 builds. Shows its title and nothing else. */
export function Placeholder({ title }: { title: string }) {
  return (
    <section className="placeholder">
      <h1 className="placeholder__title">{title}</h1>
      <p className="placeholder__note">Built in plan 4</p>
    </section>
  );
}
