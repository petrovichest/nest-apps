import type { AppUpdateStatus } from "@codexnest/protocol";
type ReloadPreparation = { waitUntil(promise: Promise<unknown>): void };
const eventName = "nest:before-app-reload";

export function onBeforeAppReload(prepare: () => Promise<unknown>): () => void {
  const listener = (event: Event) => {
    (event as CustomEvent<ReloadPreparation>).detail.waitUntil(Promise.resolve().then(prepare));
  };
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}

export async function prepareAppReload(): Promise<void> {
  const pending: Promise<unknown>[] = [];
  window.dispatchEvent(
    new CustomEvent<ReloadPreparation>(eventName, {
      detail: {
        waitUntil: (promise) => {
          pending.push(promise);
        },
      },
    }),
  );
  await Promise.all(pending);
}

export function shouldReloadClient(
  status: AppUpdateStatus | null,
  compiledVersion: string | undefined,
): boolean {
  return (
    !!compiledVersion &&
    status?.supported === true &&
    status.operation === "idle" &&
    status.currentVersion !== compiledVersion
  );
}
