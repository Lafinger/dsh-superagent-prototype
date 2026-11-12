/** Outbound notices for IM conversations when a person stopped a ticket. */
import { key, type OutboundMessage, type Ticket } from '../core/index.ts'

/**
 * Builds idempotent outbound notices for the ticket's IM conversations when a person stopped it. The main Session ends a
 * stopped ticket itself on the person's message, so no worker turn runs to tell the thread; this notice does. The language
 * follows the ticket's source request: Chinese when it contains Han characters and no kana, otherwise English.
 */
export function stopEndNotices(ticket: Ticket, request: string): OutboundMessage[] {
  const ended = ticket.ended
  if (!ended || ended.outcome !== 'stopped') return []
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const reason = ended.reason?.trim()
  const text = chinese
    ? `本计划已按人工指示终止，工单已停止。${reason ? `\n\n原因：${reason}` : ''}`
    : `This plan was stopped by a person; the ticket is closed.${reason ? `\n\nReason: ${reason}` : ''}`
  // GitHub timelines already show the stop, so GitHub channels are skipped.
  return ticket.channels.filter(channel => channel.source !== 'github').map(channel => ({
    id: key('stop-terminal', ticket.id, channel.source, JSON.stringify(channel.address)),
    channel, text, kind: 'notice' as const, ticketId: ticket.id }))
}
