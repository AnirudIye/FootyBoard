import test from 'node:test'
import assert from 'node:assert/strict'
import { limiterIp } from './rateLimit.js'

/**
 * The /64 masking, which is what stops an IPv6 caller having a fresh identity
 * per request. Pure string work, so no database: these are the shapes Node
 * actually hands `req.ip`, including the compressed and IPv4-mapped forms that
 * a naive prefix slice gets wrong.
 */
test('IPv4 addresses count as themselves', () => {
  assert.equal(limiterIp('203.0.113.7'), '203.0.113.7')
  assert.equal(limiterIp('127.0.0.1'), '127.0.0.1')
})

test('IPv4-mapped addresses are unwrapped, not masked', () => {
  // A dual-stack listener reports v4 callers this way. Masking instead of
  // unwrapping would file every one of them under a single v6 prefix.
  assert.equal(limiterIp('::ffff:203.0.113.7'), '203.0.113.7')
  assert.equal(limiterIp('::FFFF:198.51.100.9'), '198.51.100.9')
})

test('IPv6 addresses count by /64, so a whole prefix shares one allowance', () => {
  const a = limiterIp('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd')
  const b = limiterIp('2001:db8:1234:5678:0000:0000:0000:0001')
  assert.equal(a, '2001:db8:1234:5678::/64')
  assert.equal(a, b, 'two addresses in one /64 have to land in one bucket')
})

test('a different /64 is a different bucket', () => {
  assert.notEqual(
    limiterIp('2001:db8:1234:5678::1'),
    limiterIp('2001:db8:1234:9999::1'),
  )
})

test('compressed and zoned forms expand before they are cut', () => {
  assert.equal(limiterIp('2001:db8::1'), '2001:db8:0:0::/64')
  assert.equal(limiterIp('fe80::1%eth0'), 'fe80:0:0:0::/64')
  assert.equal(limiterIp('::1'), '0:0:0:0::/64')
})

test('a missing address is still a usable key', () => {
  assert.equal(limiterIp(undefined), 'unknown')
  assert.equal(limiterIp(''), 'unknown')
})
