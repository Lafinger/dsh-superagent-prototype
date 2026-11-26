import { describe, expect, it } from 'vitest'
import { pullPushTrigger } from '../src/sources/github-trigger.ts'

const pull = {
  number: 9,
  title: '设计：访问计数器重置交互',
  body: '归属计划 #6，提交设计任务 #7。',
  state: 'open',
  created_at: '2026-11-26T04:32:17Z',
  html_url: 'https://github.com/lafinger-agent/web-test/pull/9',
  user: { login: 'Lafinger', type: 'User' },
}

describe('pullPushTrigger', () => {
  it('uses the head sha in the id so every push is a distinct trigger', () => {
    const first = pullPushTrigger(pull as never, 'a'.repeat(40), '2026-11-26T05:00:00Z', 'lafinger-agent')
    const second = pullPushTrigger(pull as never, 'b'.repeat(40), '2026-11-26T05:10:00Z', 'lafinger-agent')
    expect(first.id).not.toBe(second.id)
  })

  it('keeps the plan reference so the result routing can attach it', () => {
    const trigger = pullPushTrigger(pull as never, 'c'.repeat(40), '2026-11-26T05:00:00Z', 'lafinger-agent')
    expect(trigger.text).toContain('归属计划 #6')
    expect(trigger.text).toContain('推送了新提交 ccccccc')
    expect(trigger.meta).toMatchObject({ kind: 'push', sha: 'c'.repeat(40), number: 9 })
    expect(trigger.at).toBe('2026-11-26T05:00:00Z')
  })
})
