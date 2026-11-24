import assert from 'node:assert/strict'
import test from 'node:test'
import { add, sub } from '../src/math.mjs'

test('add returns sum', () => {
  assert.equal(add(2, 3), 5)
})

test('sub returns difference', () => {
  assert.equal(sub(5, 3), 2)
})
