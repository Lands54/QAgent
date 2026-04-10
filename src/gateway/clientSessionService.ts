import type {
  GatewayClientSession,
  GatewayExecutorLease,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

export class ClientSessionService {
  private readonly clients = new Map<string, GatewayClientSession>();
  private readonly leasesByExecutor = new Map<string, GatewayExecutorLease>();
  private readonly leasesByWorkline = new Map<string, GatewayExecutorLease>();

  public openClient(input: {
    clientId: string;
    clientLabel: GatewayClientSession["clientLabel"];
  }): GatewayClientSession {
    const existing = this.clients.get(input.clientId);
    if (existing) {
      const next = {
        ...existing,
        clientLabel: input.clientLabel,
        lastSeenAt: nowIso(),
      };
      this.clients.set(next.clientId, next);
      return next;
    }

    const created: GatewayClientSession = {
      clientId: input.clientId,
      clientLabel: input.clientLabel,
      createdAt: nowIso(),
      lastSeenAt: nowIso(),
    };
    this.clients.set(created.clientId, created);
    return created;
  }

  public closeClient(clientId: string): void {
    const current = this.clients.get(clientId);
    if (!current) {
      return;
    }
    if (current.activeExecutorId) {
      this.releaseExecutor(current.activeExecutorId, clientId);
    }
    this.clients.delete(clientId);
  }

  public listClients(): GatewayClientSession[] {
    return [...this.clients.values()];
  }

  public getClient(clientId: string): GatewayClientSession | undefined {
    return this.clients.get(clientId);
  }

  public requireClient(clientId: string): GatewayClientSession {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`未找到 client：${clientId}`);
    }
    return client;
  }

  public touchClient(clientId: string): GatewayClientSession {
    const client = this.requireClient(clientId);
    const next = {
      ...client,
      lastSeenAt: nowIso(),
    };
    this.clients.set(clientId, next);
    return next;
  }

  public setClientContext(
    clientId: string,
    input: {
      activeExecutorId?: string;
      activeWorklineId?: string;
    },
  ): GatewayClientSession {
    const client = this.requireClient(clientId);
    const next = {
      ...client,
      ...input,
      lastSeenAt: nowIso(),
    };
    this.clients.set(clientId, next);
    return next;
  }

  public attachExecutor(input: {
    clientId: string;
    executorId: string;
    worklineId: string;
  }): GatewayExecutorLease {
    const owner = this.leasesByWorkline.get(input.worklineId);
    if (owner && owner.clientId !== input.clientId) {
      throw new Error(
        `工作线 ${input.worklineId} 当前由 client ${owner.clientId} 占用。`,
      );
    }

    const client = this.requireClient(input.clientId);
    if (
      client.activeExecutorId
      && client.activeExecutorId !== input.executorId
    ) {
      this.releaseExecutor(client.activeExecutorId, input.clientId);
    }

    const next: GatewayExecutorLease = {
      executorId: input.executorId,
      worklineId: input.worklineId,
      clientId: input.clientId,
      attachedAt: owner?.attachedAt ?? nowIso(),
      lastHeartbeatAt: nowIso(),
    };
    this.leasesByExecutor.set(next.executorId, next);
    this.leasesByWorkline.set(next.worklineId, next);
    this.setClientContext(input.clientId, {
      activeExecutorId: next.executorId,
      activeWorklineId: next.worklineId,
    });
    return next;
  }

  public heartbeatExecutor(executorId: string, clientId: string): GatewayExecutorLease {
    const lease = this.leasesByExecutor.get(executorId);
    if (!lease || lease.clientId !== clientId) {
      throw new Error(`执行器 ${executorId} 当前未附着到 client ${clientId}。`);
    }
    const next = {
      ...lease,
      lastHeartbeatAt: nowIso(),
    };
    this.leasesByExecutor.set(executorId, next);
    this.leasesByWorkline.set(next.worklineId, next);
    this.touchClient(clientId);
    return next;
  }

  public releaseExecutor(executorId: string, clientId?: string): void {
    const lease = this.leasesByExecutor.get(executorId);
    if (!lease) {
      return;
    }
    if (clientId && lease.clientId !== clientId) {
      throw new Error(`执行器 ${executorId} 不属于 client ${clientId}。`);
    }
    this.leasesByExecutor.delete(executorId);
    this.leasesByWorkline.delete(lease.worklineId);
    const client = this.clients.get(lease.clientId);
    if (
      client?.activeExecutorId === lease.executorId
      || client?.activeWorklineId === lease.worklineId
    ) {
      this.setClientContext(lease.clientId, {
        activeExecutorId: client.activeExecutorId === lease.executorId
          ? undefined
          : client.activeExecutorId,
        activeWorklineId: client.activeWorklineId === lease.worklineId
          ? undefined
          : client.activeWorklineId,
      });
    }
  }

  public getLeaseByExecutorId(executorId: string): GatewayExecutorLease | undefined {
    return this.leasesByExecutor.get(executorId);
  }

  public getLeaseByWorklineId(worklineId: string): GatewayExecutorLease | undefined {
    return this.leasesByWorkline.get(worklineId);
  }

  public sweepExpiredLeases(ttlMs: number): GatewayExecutorLease[] {
    const now = Date.now();
    const expired: GatewayExecutorLease[] = [];
    for (const lease of this.leasesByExecutor.values()) {
      if (now - Date.parse(lease.lastHeartbeatAt) <= ttlMs) {
        continue;
      }
      expired.push(lease);
    }
    for (const lease of expired) {
      this.releaseExecutor(lease.executorId, lease.clientId);
    }
    return expired;
  }

  public getLeaseCount(): number {
    return this.leasesByExecutor.size;
  }
}
