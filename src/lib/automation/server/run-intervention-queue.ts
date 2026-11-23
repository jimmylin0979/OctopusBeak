/**
 * The host's line of Run interventions (ADR 0147): only one is active at a
 * time. A run that reaches its pause while another is active waits, in the
 * order it arrived, and becomes active when every run ahead of it has left.
 * The host owns one queue and shares it with every Active run it opens.
 */
export type RunInterventionQueue = Readonly<{
  /**
   * Join the line. "active" when no other intervention is active, so the
   * caller is active now; otherwise "waiting", and `activate` runs once, when
   * this run's turn comes, inside the `leave` of the run ahead of it.
   */
  enter(runId: string, activate: () => void): "active" | "waiting";
  /**
   * Leave the line, whether active or waiting. When the active run leaves,
   * the next waiting run becomes active. Leaving twice does nothing.
   */
  leave(runId: string): void;
}>;

export function createRunInterventionQueue(): RunInterventionQueue {
  const line: Array<{ runId: string; activate: () => void }> = [];
  return Object.freeze({
    enter(runId, activate) {
      if (line.some((entry) => entry.runId === runId)) throw new Error(`Run ${runId} is already in the intervention queue.`);
      line.push({ runId, activate });
      return line.length > 1 ? "waiting" : "active";
    },
    leave(runId) {
      const index = line.findIndex((entry) => entry.runId === runId);
      if (index < 0) return;
      line.splice(index, 1);
      // Only the active run's leaving moves the line on.
      if (index === 0) line[0]?.activate();
    },
  });
}
