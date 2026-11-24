import assert from 'node:assert/strict'
import test from 'node:test'
import { first } from '../src/list.mjs'

test('first returns first item', () => {
  assert.equal(first([7, 8]), 7)
})

test('first returns null for empty list', () => {
  assert.equal(first([]), null)
})
