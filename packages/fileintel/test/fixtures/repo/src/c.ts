import { helper, formatName } from "./util";

export class Widget {
  private count = 0;

  increment(by: number): number {
    this.count = helper(this.count) + by;
    return this.count;
  }

  label(name: string): string {
    return formatName(name);
  }
}
