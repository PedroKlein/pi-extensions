export class FreshnessTracker {
  private turns = 0;
  private tools = 0;
  private reminderDelivered = false;
  stale = false;

  completeTurn(): void {
    this.turns += 1;
    this.refresh();
  }

  completeTool(toolName: string): void {
    if (toolName === "focus_update") return;
    this.tools += 1;
    this.refresh();
  }

  reset(): void {
    this.turns = 0;
    this.tools = 0;
    this.stale = false;
    this.reminderDelivered = false;
  }

  takeReminder(): boolean {
    if (!this.stale || this.reminderDelivered) return false;
    this.reminderDelivered = true;
    return true;
  }

  private refresh(): void {
    if (this.turns >= 3 || this.tools >= 10) this.stale = true;
  }
}
