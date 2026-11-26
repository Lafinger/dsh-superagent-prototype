/**
 * Routes a result submission to the plan's ticket.
 *
 * A pull request that names its plan (`归属计划 #N` / `plan #N`) is a role's submitted result,
 * not a new request. When the plan has a recorded owning ticket (`kv plan-link:N`), the trigger is
 * attached to that ticket instead of being assessed as a candidate, so the Coordinator hands the
 * work to the next role without waiting for anyone to paste the link in the chat.
 */

const REFERENCE = /(?:归属|所属)计划\s*[:：#]?\s*#?(\d+)|\bplan\s*#(\d+)/i

/** The plan a result text belongs to; undefined when it names none. */
export function planReference(text: string): number | undefined {
  const match = REFERENCE.exec(text)
  const value = match?.[1] ?? match?.[2]
  if (!value) return undefined
  const plan = Number(value)
  return Number.isInteger(plan) && plan > 0 ? plan : undefined
}

/** Whether the text looks like a pull request carrying a result (as opposed to a plain request). */
export function looksLikeResult(text: string): boolean {
  return /pull|merge request|\bPR\b/i.test(text) && planReference(text) !== undefined
}

