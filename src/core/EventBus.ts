// src/core/EventBus.ts

export type EventHandler<T = unknown> = (payload: T) => void;

export class EventBus {
  private listeners = new Map<string, Set<EventHandler>>();

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

  emit<T = unknown>(event: string, payload: T): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      try {
        (handler as EventHandler<T>)(payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[EventBus] Error in handler for "${event}":`, err);
      }
    }
  }

  clearAll(): void {
    this.listeners.clear();
  }
}

export const createEventBus = (): EventBus => new EventBus();
