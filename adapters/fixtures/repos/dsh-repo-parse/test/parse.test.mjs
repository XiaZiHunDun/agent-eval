import assert from 'node:assert/strict'
import test from 'node:test'
import { parseConfig } from '../src/parse.mjs'

test('parseConfig parses valid json', () => {
  assert.deepEqual(parseConfig('{"port":3080}'), { port: 3080 })
})

test('parseConfig returns null for invalid json', () => {
  assert.equal(parseConfig('{oops'), null)
})
