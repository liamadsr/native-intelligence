import { describe, it, expect } from 'vitest'
import { categoriseMcpError } from '../index'

describe('categoriseMcpError', () => {
  describe('message extraction', () => {
    it('extracts message from an Error instance', () => {
      const { error } = categoriseMcpError(new Error('something went wrong'))
      expect(error).toBe('something went wrong')
    })

    it('uses string directly when err is a plain string', () => {
      const { error } = categoriseMcpError('plain string error')
      expect(error).toBe('plain string error')
    })

    it('JSON-stringifies an arbitrary thrown value (not "Unknown error")', () => {
      const { error } = categoriseMcpError({ code: 42, msg: 'oops' })
      expect(error).toBe(JSON.stringify({ code: 42, msg: 'oops' }))
    })

    it('handles null without throwing', () => {
      const { error } = categoriseMcpError(null)
      expect(typeof error).toBe('string')
    })

    it('handles undefined without throwing', () => {
      const { error } = categoriseMcpError(undefined)
      expect(typeof error).toBe('string')
    })
  })

  describe('network_error', () => {
    it('classifies "fetch failed" as retryable network_error', () => {
      const result = categoriseMcpError(new Error('fetch failed'))
      expect(result.error_type).toBe('network_error')
      expect(result.retryable).toBe(true)
    })

    it('classifies ECONNRESET as network_error (case-insensitive)', () => {
      const result = categoriseMcpError(new Error('read ECONNRESET'))
      expect(result.error_type).toBe('network_error')
      expect(result.retryable).toBe(true)
    })

    it('classifies ECONNREFUSED as network_error', () => {
      const result = categoriseMcpError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))
      expect(result.error_type).toBe('network_error')
      expect(result.retryable).toBe(true)
    })

    it('classifies ENOTFOUND as network_error', () => {
      const result = categoriseMcpError(new Error('getaddrinfo ENOTFOUND db.supabase.co'))
      expect(result.error_type).toBe('network_error')
      expect(result.retryable).toBe(true)
    })

    it('classifies "socket hang up" as network_error', () => {
      const result = categoriseMcpError(new Error('socket hang up'))
      expect(result.error_type).toBe('network_error')
      expect(result.retryable).toBe(true)
    })
  })

  describe('timeout_error', () => {
    it('classifies "timeout" as retryable timeout_error', () => {
      const result = categoriseMcpError(new Error('query timeout after 5000ms'))
      expect(result.error_type).toBe('timeout_error')
      expect(result.retryable).toBe(true)
    })

    it('classifies "timed out" as timeout_error', () => {
      const result = categoriseMcpError(new Error('Request timed out'))
      expect(result.error_type).toBe('timeout_error')
      expect(result.retryable).toBe(true)
    })

    it('classifies "deadline exceeded" as timeout_error', () => {
      const result = categoriseMcpError(new Error('deadline exceeded'))
      expect(result.error_type).toBe('timeout_error')
      expect(result.retryable).toBe(true)
    })

    it('prioritises timeout_error over network_error when both match', () => {
      // A timeout on a fetch could mention both; timeout takes priority.
      const result = categoriseMcpError(new Error('fetch failed: timeout'))
      expect(result.error_type).toBe('timeout_error')
    })
  })

  describe('db_error', () => {
    it('classifies "permission denied" as non-retryable db_error', () => {
      const result = categoriseMcpError(new Error('permission denied for table actions'))
      expect(result.error_type).toBe('db_error')
      expect(result.retryable).toBe(false)
    })

    it('classifies "row-level security" as db_error', () => {
      const result = categoriseMcpError(
        new Error('new row violates row-level security policy for table "actions"'),
      )
      expect(result.error_type).toBe('db_error')
      expect(result.retryable).toBe(false)
    })

    it('classifies "connection reset" as db_error', () => {
      const result = categoriseMcpError(new Error('connection reset by peer'))
      expect(result.error_type).toBe('db_error')
      expect(result.retryable).toBe(false)
    })

    it('classifies "deadlock" as db_error', () => {
      const result = categoriseMcpError(new Error('deadlock detected'))
      expect(result.error_type).toBe('db_error')
      expect(result.retryable).toBe(false)
    })

    it('classifies "could not connect to server" as db_error', () => {
      const result = categoriseMcpError(new Error('could not connect to server: Connection refused'))
      expect(result.error_type).toBe('db_error')
      expect(result.retryable).toBe(false)
    })
  })

  describe('execution_error (catch-all)', () => {
    it('classifies an unknown error as non-retryable execution_error', () => {
      const result = categoriseMcpError(new Error('Cannot read properties of undefined'))
      expect(result.error_type).toBe('execution_error')
      expect(result.retryable).toBe(false)
    })

    it('classifies a plain string as execution_error', () => {
      const result = categoriseMcpError('some unexpected condition')
      expect(result.error_type).toBe('execution_error')
      expect(result.retryable).toBe(false)
    })
  })
})
