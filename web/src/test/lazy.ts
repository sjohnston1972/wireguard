// test/lazy.ts
//
// Plain English: the code-split parts of the app (src/widgets/lazy.tsx) load
// on first draw. In a busy test run the first load of a module can take
// longer than a findBy waits, so test files that draw those parts load them
// up front: `beforeAll(preloadLazy)`. (insightsLazy.test.tsx checks that the
// app itself never loads them by default, and does not call this.)
export async function preloadLazy(): Promise<void> {
  await Promise.all([
    import("@/views/overview/Insights"),
    import("@/views/overview/BootLog"),
    import("@/views/firewall/PublicIp"),
    import("@/views/activity/AzureChanges"),
    import("@/views/activity/ServiceHealth"),
    import("@/views/activity/PhoneAzure"),
    import("@/views/activity/ServiceHealthLink"),
    import("@/shell/ServiceHealthPill"),
    import("@/widgets/WidgetLibrary"),
  ]);
}
