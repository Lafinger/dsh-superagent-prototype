import { describe, expect, it } from 'vitest'
import { looksLikeResult, planReference } from '../src/app/result-routing.ts'

describe('planReference', () => {
  it('reads the plan from the labels a result carries', () => {
    expect(planReference('归属计划 #6，提交设计任务 #7')).toBe(6)
    expect(planReference('所属计划：#12')).toBe(12)
    expect(planReference('body says plan #3 and closes #7')).toBe(3)
  })
  it('is undefined when no plan is named', () => {
    expect(planReference('Closes #7')).toBeUndefined()
    expect(planReference('归属计划：#0')).toBeUndefined()
    expect(planReference('')).toBeUndefined()
  })
})

describe('looksLikeResult', () => {
  it('needs both a pull request marker and a plan', () => {
    expect(looksLikeResult('PR #9 归属计划 #6')).toBe(true)
    expect(looksLikeResult('pull request for 归属计划 #6')).toBe(true)
    expect(looksLikeResult('归属计划 #6')).toBe(false)
  })
})
