import { describe, expect, it } from 'vitest'
import { stopEndNotices } from '../src/sources/stop-notices.ts'
import type { ChannelRef, Ticket } from '../src/core/index.ts'

const feishu: ChannelRef = { source: 'feishu', address: { messageId: 'om_1', chatId: 'oc_1' } }
const github: ChannelRef = { source: 'github', address: { number: '1' } }
const make = (ended: Ticket['ended'], channels: ChannelRef[]): Ticket => ({ id: 't1', ended, channels } as unknown as Ticket)

describe('stopEndNotices', () => {
  it('stays silent unless a person stopped the ticket', () => {
    expect(stopEndNotices(make(undefined, [feishu]), '需求')).toEqual([])
    expect(stopEndNotices(make({ at: 'now', by: 'human', outcome: 'completed' }, [feishu]), '需求')).toEqual([])
  })

  it('posts a Chinese notice to the Feishu channel, skipping GitHub, with a stable id', () => {
    const ended = { at: 'now', by: 'human' as const, outcome: 'stopped' as const, reason: '审批人回复 C 终止' }
    const messages = stopEndNotices(make(ended, [feishu, github]), '极简便签需求')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.channel).toEqual(feishu)
    expect(messages[0]!.kind).toBe('notice')
    expect(messages[0]!.text).toContain('已按人工指示终止')
    expect(messages[0]!.text).toContain('审批人回复 C 终止')
    expect(messages[0]!.id).toBe(stopEndNotices(make(ended, [feishu, github]), '极简便签需求')[0]!.id)
  })

  it('uses English for a non-Chinese request', () => {
    const ended = { at: 'now', by: 'human' as const, outcome: 'stopped' as const }
    expect(stopEndNotices(make(ended, [feishu]), 'sticky notes')[0]!.text).toContain('stopped by a person')
  })
})
