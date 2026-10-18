import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "./auth";
import { acquireTokens } from "./auth";
import type { DemoConfig, Tutor } from "./config";
import { DemoError, reportError } from "./errors";
import { streamFoundry, type ChatMessage } from "./foundry";

export interface InvocationContext {
  user: AuthenticatedUser;
  config: DemoConfig;
  signal: AbortSignal;
  requestId: string;
  tokens?: typeof acquireTokens;
  fetchImpl?: typeof fetch;
}

export class FoundryTutorAgent extends AbstractAgent {
  private cancellation?: AbortController;

  constructor(private context: InvocationContext, private tutor: Tutor) {
    super({ agentId: tutor, description: tutor === "hosted" ? "Hosted tutor: delegated user-via-agent gateway access" : "Prompt tutor: managed OAuth2 gateway connection" });
  }

  override clone(): FoundryTutorAgent {
    const copy: FoundryTutorAgent = super.clone();
    copy.context = this.context;
    copy.tutor = this.tutor;
    copy.cancellation = undefined;
    return copy;
  }

  override abortRun(): void {
    this.cancellation?.abort();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      this.cancellation = controller;
      const signal = AbortSignal.any([controller.signal, this.context.signal]);
      const finish = () => subscriber.complete();
      signal.addEventListener("abort", finish, { once: true });
      const { threadId, runId } = input;
      subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });
      const execute = async () => {
        signal.throwIfAborted();
        if (input.tools.length) throw new DemoError("request", "unsupported_tools", "The tutor demo supports text chat, not client-defined tools.", 400);
        const messages: ChatMessage[] = [];
        for (const message of input.messages) {
          if (message.role !== "user" && message.role !== "assistant") {
            throw new DemoError("request", "unsupported_message", "Only user and assistant text messages are supported.", 400);
          }
          if (typeof message.content !== "string" || ("toolCalls" in message && message.toolCalls?.length)) {
            throw new DemoError("request", "unsupported_message", "Attachments and tool calls are not supported by this demo.", 400);
          }
          messages.push({ role: message.role, content: message.content });
        }
        const tokens = await (this.context.tokens ?? acquireTokens)(
          this.context.user, this.tutor, this.context.config, signal,
        );
        signal.throwIfAborted();
        const messageId = randomUUID();
        subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
        for await (const delta of streamFoundry({
          config: this.context.config, tutor: this.tutor, messages, tokens, signal,
          requestId: this.context.requestId, fetchImpl: this.context.fetchImpl,
        })) {
          signal.throwIfAborted();
          subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
        }
        signal.throwIfAborted();
        subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId });
        subscriber.next({
          type: EventType.CUSTOM, name: "demo.request",
          value: { requestId: this.context.requestId, tutor: this.tutor, status: "completed" },
        });
        subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
      };
      execute().then(() => subscriber.complete()).catch((error: unknown) => {
        if (subscriber.closed) return;
        if (signal.aborted) { subscriber.complete(); return; }
        const { body } = reportError(error, this.context.requestId);
        subscriber.next({
          type: EventType.RUN_ERROR,
          message: `${body.error.message} Request: ${body.error.requestId}`,
          code: `${body.error.stage}:${body.error.code}`,
        });
        subscriber.complete();
      });
      return () => {
        signal.removeEventListener("abort", finish);
        controller.abort();
        if (this.cancellation === controller) this.cancellation = undefined;
      };
    });
  }
}
