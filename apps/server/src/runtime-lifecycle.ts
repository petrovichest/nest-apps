import { randomBytes, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

export const RESTART_RECOVERY_PROTOCOL_VERSION = 2;

export type RecoveryState =
  "starting" | "syncing" | "recovering" | "ready" | "draining" | "unavailable" | "failed";

export interface RuntimeLifecycleParticipant {
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
}

export interface RuntimeLifecycleOptions {
  transport: "stdio" | "daemon";
  tokenPath: string;
  bridgeReady(): boolean;
  checkpoint(): Promise<void>;
  drainTimeoutMs?: number;
  drainLeaseMs?: number;
  buildCommit?: string;
  updateJournalPath?: string;
}

export class RestartTokenError extends Error {}

export class RestartPreparationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestartPreparationTimeoutError";
  }
}

type DrainPhase = "participants" | "tracked-work" | "checkpoint";

type DrainAttempt = {
  phase: DrainPhase;
};

type TrackedWork = {
  label: string;
  startedAt: number;
};

export class RuntimeLifecycle {
  private recoveryState: RecoveryState = "starting";
  private readonly participants = new Set<RuntimeLifecycleParticipant>();
  private readonly inFlight = new Map<Promise<unknown>, TrackedWork>();
  private readonly restartToken = randomBytes(32).toString("hex");
  private leaseTimer?: NodeJS.Timeout;
  private pauseController?: AbortController;
  private pausePromise?: Promise<void>;
  private activeDrain?: DrainAttempt;
  private transitionQueue = Promise.resolve();
  private shuttingDown = false;
  private admissionPending = false;
  private admissionWatcher?: FSWatcher;
  private admissionTimer?: NodeJS.Timeout;

  constructor(private readonly options: RuntimeLifecycleOptions) {}

  get state(): RecoveryState {
    return this.recoveryState;
  }

  get transport(): "stdio" | "daemon" {
    return this.options.transport;
  }

  get acceptsMutations(): boolean {
    return this.recoveryState === "ready" && !this.admissionPending;
  }

  get updatePending(): boolean {
    return this.admissionPending;
  }

  get buildCommit(): string | undefined {
    return this.options.buildCommit;
  }

  async initialize(): Promise<void> {
    this.admissionPending = !(await this.updateAdmitted());
    if (this.admissionPending) {
      const path = this.options.updateJournalPath!;
      this.admissionWatcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
        if (filename && filename !== basename(path)) return;
        if (this.admissionTimer) clearTimeout(this.admissionTimer);
        this.admissionTimer = setTimeout(() => {
          this.admissionTimer = undefined;
          void this.confirmAdmission().catch(() => undefined);
        }, 25);
        this.admissionTimer.unref();
      });
      // Cover a commit between the initial read and installing the watcher.
      await this.confirmAdmission();
    }
    await mkdir(dirname(this.options.tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(this.options.tokenPath, `${this.restartToken}\n`, { mode: 0o600 });
    await chmod(this.options.tokenPath, 0o600);
  }

  register(participant: RuntimeLifecycleParticipant): () => void {
    this.participants.add(participant);
    return () => this.participants.delete(participant);
  }

  track<T>(promise: Promise<T>, label = "runtime work"): Promise<T> {
    this.inFlight.set(promise, { label, startedAt: Date.now() });
    const cleanup = () => this.inFlight.delete(promise);
    void promise.then(cleanup, cleanup);
    return promise;
  }

  syncing(): void {
    if (this.recoveryState !== "draining") this.recoveryState = "syncing";
  }

  recovering(): void {
    if (this.recoveryState !== "draining") this.recoveryState = "recovering";
  }

  ready(): void {
    if (this.recoveryState !== "draining" && this.options.bridgeReady()) {
      this.recoveryState = "ready";
    }
  }

  unavailable(): void {
    if (this.recoveryState !== "draining") this.recoveryState = "unavailable";
  }

  failed(): void {
    if (this.recoveryState !== "draining") this.recoveryState = "failed";
  }

  async prepare(token: string): Promise<void> {
    this.assertToken(token);
    await this.transition(async () => {
      if (this.shuttingDown) throw new Error("CodexNest shutdown is already in progress");
      if (!this.pausePromise) {
        this.recoveryState = "draining";
        this.pauseController = new AbortController();
        const attempt: DrainAttempt = { phase: "participants" };
        this.activeDrain = attempt;
        this.pausePromise = this.pauseAndCheckpoint(this.pauseController.signal, attempt).finally(
          () => {
            if (this.activeDrain === attempt) this.activeDrain = undefined;
          },
        );
      }
      try {
        await within(
          this.pausePromise,
          this.options.drainTimeoutMs ?? 60_000,
          () => new RestartPreparationTimeoutError(this.restartTimeoutMessage()),
        );
      } catch (error) {
        this.pauseController?.abort();
        await Promise.all(
          [...this.participants].map((participant) =>
            Promise.resolve(participant.resume()).catch(() => undefined),
          ),
        );
        this.pauseController = undefined;
        this.pausePromise = undefined;
        this.activeDrain = undefined;
        this.recoveryState = this.options.bridgeReady() ? "ready" : "unavailable";
        throw error;
      }
      this.armLease();
    });
  }

  async resume(token: string): Promise<void> {
    this.assertToken(token);
    await this.transition(async () => {
      if (this.shuttingDown || !this.pausePromise) return;
      this.clearLease();
      this.pauseController?.abort();
      let failed = false;
      try {
        await Promise.all([...this.participants].map((participant) => participant.resume()));
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        this.pauseController = undefined;
        this.pausePromise = undefined;
        this.recoveryState = failed
          ? "failed"
          : this.options.bridgeReady()
            ? "ready"
            : "unavailable";
      }
    });
  }

  async prepareShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.transition(async () => {
      this.clearLease();
      this.recoveryState = "draining";
      if (!this.pausePromise) {
        this.pauseController = new AbortController();
        const attempt: DrainAttempt = { phase: "participants" };
        this.activeDrain = attempt;
        this.pausePromise = this.pauseAndCheckpoint(this.pauseController.signal, attempt).finally(
          () => {
            if (this.activeDrain === attempt) this.activeDrain = undefined;
          },
        );
      }
      await this.pausePromise;
    });
  }

  async close(): Promise<void> {
    this.admissionWatcher?.close();
    if (this.admissionTimer) clearTimeout(this.admissionTimer);
    this.clearLease();
    this.pauseController?.abort();
    await unlink(this.options.tokenPath).catch(() => undefined);
  }

  private async updateAdmitted(): Promise<boolean> {
    const { updateJournalPath, buildCommit } = this.options;
    if (!updateJournalPath || !buildCommit) return true;
    const metadata = await lstat(updateJournalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return false;
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("Unsafe update recovery journal");
    }
    const value = JSON.parse(await readFile(updateJournalPath, "utf8"));
    if (
      value.schemaVersion !== 1 ||
      !["clean", "pending", "restoring", "committed", "aborted"].includes(value.phase)
    ) {
      throw new Error("Unsupported update recovery journal");
    }
    // The recorded baseline can always resume its own work. A new candidate
    // cannot accept private-runtime work until the updater confirms that build.
    return (
      value.baseline?.commit === buildCommit ||
      (value.phase === "clean" && value.target?.commit === buildCommit) ||
      (value.phase === "committed" && value.target?.commit === buildCommit)
    );
  }

  private async confirmAdmission(): Promise<void> {
    if (!this.admissionPending || !(await this.updateAdmitted())) return;
    await this.transition(async () => {
      if (!this.admissionPending || this.shuttingDown) return;
      this.admissionPending = false;
      this.admissionWatcher?.close();
      if (this.recoveryState !== "ready") return;
      this.recoveryState = "recovering";
      try {
        await Promise.all([...this.participants].map((participant) => participant.resume()));
        if (this.recoveryState === "recovering") this.ready();
      } catch (error) {
        this.failed();
        throw error;
      }
    });
  }

  private async pauseAndCheckpoint(signal: AbortSignal, attempt: DrainAttempt): Promise<void> {
    await Promise.all([...this.participants].map((participant) => participant.pause()));
    attempt.phase = "tracked-work";
    while (!signal.aborted && this.inFlight.size) {
      await Promise.all([...this.inFlight.keys()].map((pending) => pending.catch(() => undefined)));
    }
    if (signal.aborted) return;
    attempt.phase = "checkpoint";
    await this.options.checkpoint();
  }

  private restartTimeoutMessage(): string {
    if (this.activeDrain?.phase === "participants") {
      return "CodexNest restart preparation timed out while pausing runtime participants";
    }
    if (this.activeDrain?.phase === "checkpoint") {
      return "CodexNest restart preparation timed out while checkpointing durable state";
    }
    const pending = [...this.inFlight.values()].sort(
      (left, right) => left.startedAt - right.startedAt,
    );
    if (!pending.length) {
      return "CodexNest restart preparation timed out while waiting for tracked work";
    }
    const details = pending
      .slice(0, 3)
      .map(
        (work) =>
          `${work.label} (${Math.max(0, Math.round((Date.now() - work.startedAt) / 1_000))}s)`,
      )
      .join(", ");
    const remainder = pending.length > 3 ? `, and ${pending.length - 3} more` : "";
    return `CodexNest restart preparation timed out while waiting for ${pending.length} tracked operation${pending.length === 1 ? "" : "s"}: ${details}${remainder}`;
  }

  private transition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionQueue.then(operation, operation);
    this.transitionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private armLease(): void {
    this.clearLease();
    this.leaseTimer = setTimeout(() => {
      void this.resume(this.restartToken).catch(() => undefined);
    }, this.options.drainLeaseMs ?? 120_000);
    this.leaseTimer.unref();
  }

  private clearLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
  }

  private assertToken(value: string): void {
    const expected = Buffer.from(this.restartToken);
    const actual = Buffer.from(value.trim());
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new RestartTokenError("Invalid restart token");
    }
  }
}

function within<T>(promise: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
