/** Provider confirmation, independent of the acknowledgement for a start or interrupt request. */
export class CompactTurn {
  turnId?: string;
  before?: number;
  boundary = false;
  readonly done: Promise<{ compacted: boolean; before?: number }>;
  finish!: () => void;
  fail!: (reason: Error) => void;

  constructor() {
    this.done = new Promise((resolve, reject) => {
      this.finish = () => resolve({ compacted: this.boundary, before: this.before });
      this.fail = reject;
    });
  }
}
