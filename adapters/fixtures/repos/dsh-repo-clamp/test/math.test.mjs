import assert from 'node:assert/strict'
import test from 'node:test'
import * as math from '../src/math.mjs'

test('add returns sum', () => {
  assert.equal(math.add(2, 3), 5)
})

test('sub returns difference', () => {
  assert.equal(math.sub(5, 3), 2)
})

test('clamp keeps value inside range', () => {
  assert.equal(math.clamp(15, 0, 10), 10)
  assert.equal(math.clamp(-1, 0, 10), 0)
  assert.equal(math.clamp(5, 0, 10), 5)
})
