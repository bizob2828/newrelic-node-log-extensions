'use strict'

const tap = require('tap')
const utils = require('@newrelic/test-utilities')
const concat = require('concat-stream')

utils(tap)

tap.test('Winston instrumentation', (t) => {
  t.autoend()

  let helper = null
  let winston = null
  t.beforeEach((done) => {
    helper = utils.TestAgent.makeInstrumented()
    helper.registerInstrumentation({
      moduleName: 'logform',
      type: 'generic',
      onRequire: require('../../lib/instrumentation'),
      onError: done
    })
    winston = require('winston')
    done()
  })
  t.afterEach((done) => {
    helper.unload()
    done()
  })

  // Keep track of the number of streams that we're waiting to close and test.  Also clean
  // up the info object used by winston/logform to make it easier to test.
  function makeStreamTest(t) {
    let toBeClosed = 0

    // Assert function will receive log strings to be tested
    return function streamTest(assertFn) {
      // When creating a stream test, increment the number of streams to wait to close.
      ++toBeClosed

      // This function will be given to `concat` and will receive an array of messages
      // from Winston when the stream closes.
      return function(msgs) {
        // We only want the log string from the message object. This is stored on the
        // object on a key that is a symbol. Grab that and give it to the assert function.
        const logStrings = msgs.map((msg) => {
          const symbols = Object.getOwnPropertySymbols(msg)
          const msgSym = symbols.filter((s) => s.toString() === 'Symbol(message)')[0]
          return msg[msgSym]
        })

        assertFn(logStrings)

        // If this function is called it is because the stream closed. Decrement the
        // number of streams we're waiting for and end the test if it's the last one.
        if (--toBeClosed === 0) {
          t.end()
        }
      }
    }
  }

  // Helper function to compare a json-parsed log msg against the values we expect.
  function validateAnnotations(t, msg, expected) {
    Object.keys(expected).forEach((a) => {
      t.type(msg[a], 'string', 'should have the proper keys')
      if (expected[a] !== null) {
        t.equal(msg[a], expected[a], 'should have the expected value')
      }
    })
  }

  t.test('should add linking metadata to JSON logs', (t) => {
    const config = helper.agent.config

    // These should show up in the JSON via the combined formatters in the winston config.
    const loggingAnnotations = {
      timestamp: new Date().getFullYear().toString(),
      label: 'test'
    }

    // These values should be added by the instrumentation even when not in a transaction.
    const basicAnnotations = {
      'entity.name': config.applications()[0],
      'entity.type': 'SERVICE',
      'hostname': config.getHostnameSafe()
    }

    // These will be assigned when inside a transaction below and should be in the JSON.
    let transactionAnnotations

    const streamTest = makeStreamTest(t)

    // These streams are passed to the Winston config below to capture the
    // output of the logging. `concat` captures all of a stream and passes it to
    // the given function.
    const jsonStream = concat(streamTest((msgs) => {
      msgs.forEach((msg) => {
        // Make sure the JSON stream actually gets JSON
        let msgJson
        t.doesNotThrow(() => msgJson = JSON.parse(msg), 'should be JSON')

        // Verify the proper keys are there
        validateAnnotations(t, msgJson, basicAnnotations)
        validateAnnotations(t, msgJson, loggingAnnotations)

        // Test that transaction keys are there if in a transaction
        if (msg.message === 'in trans') {
          validateAnnotations(t, msgJson, transactionAnnotations)
        }
      })
    }))

    const simpleStream = concat(streamTest((msgs) => {
      msgs.forEach((msg) => {
        t.throws(() => JSON.parse(msg), 'should not be json parsable')
        t.ok(/^info:.*trans$/.exec(msg), 'should not have metadata keys')
      })
    }))

    // Example Winston setup to test
    const logger = winston.createLogger({
      transports: [
        // Log to a stream so we can test the output
        new winston.transports.Stream({
          level: 'info',
          // Format combos are used here to test that the shim doesn't affect
          // format piping
          format: winston.format.combine(
            winston.format.timestamp({format: 'YYYY'}),
            winston.format.label({label: 'test'}),
            winston.format.json()
          ),
          stream: jsonStream
        }),
        new winston.transports.Stream({
          level: 'info',
          format: winston.format.simple(),
          stream: simpleStream
        })
      ]
    })

    // Log some stuff, both in and out of a transaction
    logger.info('out of trans')

    helper.runInTransaction('test', (txn) => {
      logger.info('in trans')

      // Capture info about the transaction that should show up in the logs
      transactionAnnotations = {
        'trace.id': txn.getTraceId(),
        'span.id': txn.getSpanId()
      }

      // Force the streams to close so that we can test the output
      jsonStream.end()
      simpleStream.end()
    })
  })
})