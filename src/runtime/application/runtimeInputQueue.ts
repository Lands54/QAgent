export type ApprovalHandlingMode = "interactive" | "checkpoint";

export interface QueuedInputTask {
  input: string;
  buildModelInputAppendix?: () => Promise<string | undefined>;
  approvalMode?: ApprovalHandlingMode;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface RuntimeInputQueueDeps {
  isDisposed(): boolean;
  hasPendingApproval(): boolean;
  isRunning(): boolean;
  onStateChanged(): void;
  executeQueuedInput(task: QueuedInputTask): Promise<void>;
}

export class RuntimeInputQueue {
  private readonly queuedInputs: QueuedInputTask[] = [];
  private drainingInputQueue = false;

  public constructor(private readonly deps: RuntimeInputQueueDeps) {}

  public getCount(): number {
    return this.queuedInputs.length;
  }

  public async submitInput(
    input: string,
    options?: {
      buildModelInputAppendix?: () => Promise<string | undefined>;
      approvalMode?: ApprovalHandlingMode;
    },
  ): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.queuedInputs.push({
        input: trimmed,
        buildModelInputAppendix: options?.buildModelInputAppendix,
        approvalMode: options?.approvalMode,
        resolve,
        reject,
      });
      this.deps.onStateChanged();
      void this.drain();
    });
  }

  public scheduleDrain(): void {
    if (this.deps.isDisposed() || this.deps.hasPendingApproval() || this.deps.isRunning()) {
      return;
    }
    if (this.queuedInputs.length === 0) {
      this.deps.onStateChanged();
      return;
    }
    void this.drain();
  }

  public clear(): void {
    const queued = this.queuedInputs.splice(0, this.queuedInputs.length);
    for (const task of queued) {
      task.resolve();
    }
  }

  private async drain(): Promise<void> {
    if (
      this.drainingInputQueue
      || this.deps.isDisposed()
      || this.deps.hasPendingApproval()
      || this.deps.isRunning()
    ) {
      return;
    }
    const next = this.queuedInputs.shift();
    if (!next) {
      return;
    }

    this.drainingInputQueue = true;
    this.deps.onStateChanged();
    try {
      await this.deps.executeQueuedInput(next);
      next.resolve();
    } catch (error) {
      next.reject(error);
    } finally {
      this.drainingInputQueue = false;
      this.deps.onStateChanged();
      this.scheduleDrain();
    }
  }
}
