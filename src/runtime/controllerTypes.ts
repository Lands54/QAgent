import type { CommandRequest, CommandResult, RuntimeEvent } from "../types.js";
import type { AppState } from "./appState.js";

export interface AppControllerLike {
  getState(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
  subscribeRuntimeEvents(listener: (event: RuntimeEvent) => void): () => void;
  submitInput(input: string): Promise<void>;
  executeCommand(request: CommandRequest): Promise<CommandResult>;
  approvePendingRequest(approved: boolean): Promise<void>;
  requestExit(): Promise<void>;
  waitForExit(): Promise<void>;
  dispose(): Promise<void>;
  interruptAgent(): Promise<void>;
  resumeAgent(): Promise<void>;
  switchAgent(agentId: string): Promise<void>;
  switchAgentRelative(offset: number): Promise<void>;
}
