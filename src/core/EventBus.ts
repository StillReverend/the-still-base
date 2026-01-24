// src/core/EventBus.ts

export type EventHandler<T = unknown> = (payload: T) => void;

export type AnyEventPayload = { event: string; payload: unknown };

export class EventBus {
  private listeners = new Map<string, Set<EventHandler>>();

  // DEV tooling hook: allows a debug overlay (or similar) to observe all events.
  // Not used by core gameplay logic.
  private anyListeners = new Set<EventHandler<AnyEventPayload>>();

  on<T = unknown>(event: string, handler: EventHandler<T>): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as EventHandler);
  }

  off<T = unknown>(event: string, handler: EventHandler<T>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler as EventHandler);
    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): void {
    const wrapped: EventHandler<T> = (payload) => {
      this.off(event, wrapped);
      handler(payload);
    };
    this.on(event, wrapped);
  }

  onAny(handler: EventHandler<AnyEventPayload>): void {
    this.anyListeners.add(handler);
  }

  offAny(handler: EventHandler<AnyEventPayload>): void {
    this.anyListeners.delete(handler);
  }

  emit<T = unknown>(event: string, payload: T): void {
    const set = this.listeners.get(event);
    if (set && set.size > 0) {
      for (const handler of set) {
        try {
          (handler as EventHandler<T>)(payload);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[EventBus] Error in handler for "${event}":`, err);
        }
      }
    }

    if (this.anyListeners.size > 0) {
      const anyPayload: AnyEventPayload = { event, payload: payload as unknown };
      for (const handler of this.anyListeners) {
        try {
          handler(anyPayload);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[EventBus] Error in onAny handler for "${event}":`, err);
        }
      }
    }
  }

  clearAll(): void {
    this.listeners.clear();
    this.anyListeners.clear();
  }
}

export const createEventBus = (): EventBus => new EventBus();
