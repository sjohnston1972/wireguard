// widgets/lazy.tsx
//
// Plain English: load a part of the page only when it is drawn, so the main
// bundle stays small (the Azure insights widgets, off by default, and their
// boot log modal). A widget that is off renders nothing (see Widget.tsx), so
// its code is never fetched; turned on, it shows its panel's outline with a
// grey placeholder for the moment the code takes to arrive.
//
// After a deploy, an open tab may ask for a chunk the new build no longer has.
// Then the widget says so and offers a reload, instead of breaking the page;
// a modal (lazyPart) says it in a toast.

import { Component, Suspense, lazy, useEffect, type ComponentType, type ReactNode } from "react";
import { ErrorState, Panel, Skeleton, useToast } from "@/components";

/** One component of a module, as a `lazy` default. */
type Loader<P> = () => Promise<ComponentType<P>>;

class LoadBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    console.error("A part of the page could not be loaded:", e instanceof Error ? e.message : e);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const reload = () => window.location.reload();

/** A widget panel loaded on first draw: its titled outline and a placeholder while loading, a reload offer if loading fails. */
export function lazyWidget<P extends object>(title: string, load: Loader<P>): ComponentType<P> {
  const L = lazy(async () => ({ default: await load() }));
  function LazyWidget(props: P) {
    return (
      <LoadBoundary
        fallback={
          <Panel title={title}>
            <ErrorState title="This widget needs a reload" message="The dashboard was updated since this page opened. Retry reloads the page." onRetry={reload} />
          </Panel>
        }
      >
        <Suspense
          fallback={
            // Untitled, so it is not taken for the widget itself (no region of that name until the code is in).
            <Panel>
              <div aria-busy="true" aria-label={`Loading ${title}`}>
                <p className="panel__title">{title}</p>
                <Skeleton variant="block" height={96} />
              </div>
            </Panel>
          }
        >
          <L {...props} />
        </Suspense>
      </LoadBoundary>
    );
  }
  LazyWidget.displayName = `Lazy(${title})`;
  return LazyWidget;
}

function FailedToast() {
  const { toast } = useToast();
  useEffect(() => {
    toast({ tone: "error", title: "The dashboard was updated since this page opened. Reload to open this." });
  }, [toast]);
  return null;
}

/** A modal or other part with no outline of its own, loaded on first draw: nothing while loading, a toast if loading fails. */
export function lazyPart<P extends object>(load: Loader<P>): ComponentType<P> {
  const L = lazy(async () => ({ default: await load() }));
  function LazyPart(props: P) {
    return (
      <LoadBoundary fallback={<FailedToast />}>
        <Suspense fallback={null}>
          <L {...props} />
        </Suspense>
      </LoadBoundary>
    );
  }
  return LazyPart;
}
