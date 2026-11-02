import { fork, type ChildProcess } from "node:child_process";
import type { Config } from "./config.js";
import { AsrError, cancelled } from "./errors.js";
import type { Transcript } from "./inference.js";

export interface Transcriber {
  ready: boolean;
  onUnavailable?: () => void;
  start(): Promise<void>;
  run(audio: Uint8Array, language: string, signal: AbortSignal): Promise<Transcript>;
  close(): Promise<void>;
}

/** The native call is synchronous; cancellation terminates its entire process. */
export class ChildTranscriber implements Transcriber {
  ready = false;
  onUnavailable?: () => void;
  private child?: ChildProcess;
  private exited: Promise<void> = Promise.resolve();
  private pending?: { resolve: (value: Transcript) => void; reject: (error: Error) => void };

  constructor(private readonly config: Config) {}

  async start(): Promise<void> {
    await this.close();
    const child = fork(new URL("./worker.js", import.meta.url), [JSON.stringify({ modelDir: this.config.modelDir, threads: this.config.threads })], {
      stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
      env: { PATH: process.env.PATH, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH, NODE_ENV: "production" },
    });
    this.child = child;
    this.exited = new Promise(resolve => child.once("close", () => {
      this.ready = false;
      if (this.child === child) this.child = undefined;
      this.pending?.reject(new AsrError("worker_failed", "Recognition worker exited", 503));
      this.pending = undefined;
      resolve();
      this.onUnavailable?.();
    }));
    let cleanup = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new AsrError("worker_timeout", "Model loading timed out", 503)), this.config.startupTimeoutMs);
        const message = (value: { type?: string }) => {
          if (value.type === "ready") { this.ready = true; resolve(); }
          else reject(new AsrError("worker_failed", "Model loading failed", 503));
        };
        const error = () => reject(new AsrError("worker_failed", "Recognition worker could not start", 503));
        const exit = () => reject(new AsrError("worker_failed", "Recognition worker exited before readiness", 503));
        child.once("message", message); child.once("error", error); child.once("close", exit);
        cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("error", error); child.off("close", exit); };
      });
    } catch (error) { await this.close(); throw error; }
    finally { cleanup(); }
    child.on("error", () => { this.pending?.reject(new AsrError("worker_failed", "Recognition transport failed", 503)); });
    child.on("message", (message: { type?: string; value?: Transcript }) => {
      const pending = this.pending;
      if (!pending) return;
      this.pending = undefined;
      const value = message.value;
      if (message.type !== "result" || !value || typeof value.text !== "string" || !Number.isFinite(value.audioSeconds)
        || !Number.isFinite(value.inferenceSeconds) || value.text.length > 128 * 1024) {
        pending.reject(new AsrError("worker_failed", "Invalid recognition response", 503));
      } else pending.resolve(value);
    });
  }

  async run(audio: Uint8Array, language: string, signal: AbortSignal): Promise<Transcript> {
    signal.throwIfAborted();
    const child = this.child;
    if (!child?.connected || !this.ready) throw new AsrError("not_ready", "Recognition worker is not ready", 503);
    let abort: () => void = () => {};
    try {
      return await new Promise<Transcript>((resolve, reject) => {
        this.pending = { resolve, reject };
        abort = () => {
          this.pending = undefined;
          void this.close().then(() => reject(signal.reason instanceof Error ? signal.reason : cancelled()), reject);
        };
        signal.addEventListener("abort", abort, { once: true });
        child.send({ audio, language }, error => {
          if (error) reject(new AsrError("worker_failed", "Recognition transport failed", 503));
        });
      });
    } finally { signal.removeEventListener("abort", abort); this.pending = undefined; }
  }

  async close(): Promise<void> {
    this.ready = false;
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 1000);
    try { await this.exited; } finally { clearTimeout(force); }
  }
}

interface Job {
  audio: Uint8Array;
  language: string;
  controller: AbortController;
  queuedAt: number;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
  resolve: (result: Transcript & { queueSeconds: number }) => void;
  reject: (error: Error) => void;
}
interface Slot { worker: Transcriber; busy: boolean; starting: boolean; retry?: ReturnType<typeof setTimeout> }

/** Bounded FIFO queue; each worker owns a single model instance. */
export class RecognitionQueue {
  private readonly slots: Slot[];
  private readonly waiting: Job[] = [];
  private readonly running = new Set<Job>();
  private readonly active = new Set<Promise<void>>();
  private readonly starting = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly config: Config, factory: () => Transcriber = () => new ChildTranscriber(config)) {
    this.slots = Array.from({ length: config.workers }, () => {
      const slot: Slot = { worker: factory(), busy: false, starting: false };
      slot.worker.onUnavailable = () => { if (!this.closed && !slot.busy) void this.initialize(slot); };
      return slot;
    });
  }

  get ready(): boolean { return !this.closed && this.slots.some(slot => slot.worker.ready); }

  async start(): Promise<void> { await Promise.all(this.slots.map(slot => this.initialize(slot))); }

  private async initialize(slot: Slot): Promise<void> {
    if (this.closed || slot.starting) return;
    slot.starting = true;
    const task = slot.worker.start();
    this.starting.add(task);
    try { await task; }
    catch {
      if (!this.closed) slot.retry = setTimeout(() => { void this.initialize(slot); }, 1000);
    } finally {
      this.starting.delete(task); slot.starting = false;
      if (this.closed) await slot.worker.close();
      else this.pump();
    }
  }

  transcribe(audio: Uint8Array, language: string, signal: AbortSignal): Promise<Transcript & { queueSeconds: number }> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (!this.ready) return Promise.reject(new AsrError("not_ready", "Recognition models are not ready", 503));
    const idle = this.slots.some(slot => !slot.busy && slot.worker.ready);
    if (!idle && this.waiting.length >= this.config.maxQueue) return Promise.reject(new AsrError("queue_full", "Recognition queue is full", 429));
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const abort = () => {
        const index = this.waiting.indexOf(job);
        if (index >= 0) { this.waiting.splice(index, 1); this.finish(job); reject(cancelled()); }
        else controller.abort(cancelled());
      };
      const job: Job = {
        audio, language, controller, queuedAt: performance.now(), resolve, reject,
        detach: () => signal.removeEventListener("abort", abort),
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(job);
          if (index < 0) return;
          this.waiting.splice(index, 1); this.finish(job);
          reject(new AsrError("queue_timeout", "Recognition queue wait timed out", 429));
        }, this.config.queueTimeoutMs),
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(job); this.pump();
    });
  }

  private finish(job: Job): void {
    clearTimeout(job.timer); job.detach();
    job.audio = new Uint8Array();
  }

  private pump(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.busy || slot.starting || !slot.worker.ready) continue;
      const job = this.waiting.shift();
      if (!job) return;
      slot.busy = true; this.running.add(job); clearTimeout(job.timer);
      const task = this.execute(slot, job);
      this.active.add(task);
      void task.finally(() => this.active.delete(task));
    }
  }

  private async execute(slot: Slot, job: Job): Promise<void> {
    const queueSeconds = (performance.now() - job.queuedAt) / 1000;
    const timer = setTimeout(() => job.controller.abort(new AsrError("inference_timeout", "Recognition timed out", 504)), this.config.inferenceTimeoutMs);
    let failed = false;
    try {
      const result = await slot.worker.run(job.audio, job.language, job.controller.signal);
      job.controller.signal.throwIfAborted();
      job.resolve({ ...result, queueSeconds });
    } catch (error) {
      failed = true;
      await slot.worker.close();
      job.reject(error instanceof AsrError ? error : new AsrError("worker_failed", "Recognition failed", 503));
    } finally {
      clearTimeout(timer); this.finish(job); this.running.delete(job); slot.busy = false;
      if (failed && !this.closed) await this.initialize(slot);
      this.pump();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const slot of this.slots) clearTimeout(slot.retry);
    for (const job of this.waiting.splice(0)) { this.finish(job); job.reject(cancelled()); }
    for (const job of this.running) job.controller.abort(cancelled());
    await Promise.all(this.slots.map(slot => slot.worker.close()));
    await Promise.all([...this.active, ...this.starting]);
  }
}
