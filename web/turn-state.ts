export type TurnId = string | number;
export interface TurnEvent { type: string; state?: string; turnId?: TurnId }

/** Pair ordered listening acknowledgments with starts, including starts cancelled before acknowledgment. */
export class TurnGate {
  #pendingStarts: boolean[] = [];
  #current: TurnId | undefined;
  get current(): TurnId | undefined { return this.#current; }
  start(): void { this.cancel(); this.#pendingStarts.push(true); }
  cancel(): void { this.#current = undefined; this.#pendingStarts.fill(false); }
  reset(): void { this.cancel(); this.#pendingStarts = []; }
  accept(event: TurnEvent): boolean {
    if (event.type === 'status' && event.state === 'listening') {
      const wanted = this.#pendingStarts.shift();
      if (!wanted || event.turnId === undefined) return false;
      this.#current = event.turnId;
      return true;
    }
    if (event.turnId === undefined) return event.type === 'error';
    return this.#current !== undefined && event.turnId === this.#current;
  }
}
