import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_URL, MAX_RETRIES } from '../src/config.mjs'

test('MAX_RETRIES is 3', () => {
  assert.equal(MAX_RETRIES, 3)
})

test('default url is unchanged', () => {
  assert.equal(DEFAULT_URL, 'http://127.0.0.1:3080')
})
