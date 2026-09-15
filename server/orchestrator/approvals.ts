/**
 * The human approval gate.
 *
 * Implemented inside the gated tools rather than through the SDK's
 * `canUseTool` permission callback. Testing showed that callback is invoked for
 * the main thread but not reliably for subagent tool calls - subagents got
 * "Tool permission request failed: AbortError: Stream closed" and then fell
 * back to guessing, which is the worst possible failure mode for a gate.
 *
 * Blocking inside the tool handler is both more robust and more honest: the
 * tool genuinely does not return until a human decides, whoever called it.
 */
import { nanoid } from 'nanoid';
import { approvals, missions } from '../db.ts';
import { bus } from '../bus.ts';
import type { Approval } from '../types.ts';

interface Pending {
  resolve: (decision: { approved: boolean; reason?: string }) => void;
  missionId: string;
}

const pending = new Map<string, Pending>();

/** Abort controllers per mission, so cancelling releases any open gate. */
const missionAborts = new Map<string, AbortController>();

export function registerMissionAbort(missionId: string, controller: AbortController) {
  missionAborts.set(missionId, controller);
  controller.signal.addEventListener('abort', () => {
    for (const [id, entry] of pending) {
      if (entry.missionId !== missionId) continue;
      pending.delete(id);
      approvals.decide(id, 'rejected', 'system', 'Mission cancelled while awaiting a decision.');
      entry.resolve({ approved: false, reason: 'Mission cancelled by the operator.' });
    }
  });
}

export function releaseMissionAbort(missionId: string) {
  missionAborts.delete(missionId);
}

export interface GateRequest {
  missionId: string;
  actor: string;
  toolName: string;
  summary: string;
  input: unknown;
}

/**
 * Ask a human, and block until they answer.
 *
 * Resolves with the decision; never rejects. The caller decides what a
 * rejection means for its own operation.
 */
export function requestApproval(req: GateRequest): Promise<{ approved: boolean; reason?: string }> {
  const id = nanoid(10);
  const record = approvals.create({
    id,
    missionId: req.missionId,
    actor: req.actor,
    toolName: req.toolName,
    summary: req.summary,
    input: req.input,
  });

  missions.setStatus(req.missionId, 'awaiting_approval');
  bus.publish({ channel: 'mission', payload: { missionId: req.missionId, status: 'awaiting_approval' } });
  bus.emitEvent({
    missionId: req.missionId,
    type: 'approval.requested',
    actor: req.actor,
    text: `Awaiting human go/no-go: ${req.summary}`,
    data: record,
  });
  bus.publish({ channel: 'approval', payload: record });

  return new Promise((resolve) => pending.set(id, { resolve, missionId: req.missionId }));
}

/** Record a human decision and unblock the waiting tool. */
export function resolveApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string,
  reason?: string,
): Approval | null {
  const entry = pending.get(approvalId);
  if (!entry) return null;
  pending.delete(approvalId);

  const record = approvals.decide(approvalId, decision, decidedBy, reason);
  bus.emitEvent({
    missionId: entry.missionId,
    type: 'approval.decided',
    actor: decidedBy,
    text:
      decision === 'approved'
        ? `Approved: ${record.summary}`
        : `Rejected: ${record.summary}${reason ? ` - ${reason}` : ''}`,
    data: record,
  });

  // The mission resumes the moment the gate clears.
  if (missions.get(entry.missionId)?.status === 'awaiting_approval') {
    missions.setStatus(entry.missionId, 'running');
    bus.publish({ channel: 'mission', payload: { missionId: entry.missionId, status: 'running' } });
  }

  entry.resolve({ approved: decision === 'approved', reason });
  return record;
}

export const hasPending = (approvalId: string) => pending.has(approvalId);
