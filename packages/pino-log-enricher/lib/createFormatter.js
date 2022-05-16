/*
 * Copyright 2021 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'
const truncate = require('./truncate')
const build = require('pino-abstract-transport')
const { pipeline, Transform } = require('stream')
const SonicBoom = require('sonic-boom')
const { once } = require('events')
const levelMap = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal'
}

/**
 * Returns a series of formatters/mixins to enrich
 * logs to work with New Relic logs
 *
 * @param {Object} newrelic
 */
module.exports = async function createFormatter(newrelic, opts) {
  // Stub API means agent is not enabled.
  if (!newrelic.shim) {
    // Continue to log original message with JSON formatter
    return {}
  }

  createModuleUsageMetric(newrelic.shim.agent)
  // SonicBoom is necessary to avoid loops with the main thread.
  // It is the same of pino.destination().
  const destination = new SonicBoom({ dest: opts.destination || 1, sync: false })
  await once(destination, 'ready')

  return build(async function (source) {
    for await (let obj of source) {
      obj.message = obj.msg
      obj.timestamp = Date.now()
      obj.level = levelMap[obj.level] || obj.level
      if (obj.err) {
        obj['error.message'] = truncate(obj.err.message)
        obj['error.stack'] = truncate(obj.err.stack)
        obj['error.class'] = obj.err.name === 'Error' ? obj.err.constructor.name : obj.err.name
        delete obj.err
      }
      delete obj.msg
      delete obj.time
      const config = newrelic.shim.agent.config

      // TODO: update the peerdep on the New Relic repo and thereby
      // remove check for existence of application_logging config item
      if (
        config.application_logging &&
        config.application_logging.enabled &&
        config.application_logging.metrics.enabled
      ) {
        // We'll try to use level labels for the metric name, but if
        // they don't exist, we'll default back to the level number.
        newrelic.shim.agent.metrics.getOrCreateMetric('Logging/lines').incrementCallCount()
        newrelic.shim.agent.metrics
          .getOrCreateMetric(`Logging/lines/${obj.level}`)
          .incrementCallCount()
      }
      const priority = obj.priority
      delete obj.priority
      if (obj['trace.id'] && newrelic.agent.logs) {
        newrelic.agent.logs.add(obj, priority)
      }
      const jsonLog = JSON.stringify(obj)
      destination.write(`${jsonLog}\n`)
    }
  }, {
    async close (err, cb) {
      destination.end()
      await once(destination, 'close')
    }
  })
}
/*
  // Using pino API to modify log lines
  // https://github.com/pinojs/pino/blob/master/docs/api.md#level
  return {
    timestamp: () => `,"timestamp": "${Date.now()}"`,
    messageKey: 'message',
    mixin() {
      return newrelic.getLinkingMetadata(true)
    },
    formatters: {
      log(obj) {
        if (obj.err) {
          obj['error.message'] = truncate(obj.err.message)
          obj['error.stack'] = truncate(obj.err.stack)
          obj['error.class'] = obj.err.name === 'Error' ? obj.err.constructor.name : obj.err.name
          delete obj.err
        }
        return obj
      }
    },
    hooks: {
      logMethod(inputArgs, method, level) {
        const config = newrelic.shim.agent.config

        // TODO: update the peerdep on the New Relic repo and thereby
        // remove check for existence of application_logging config item
        if (
          config.application_logging &&
          config.application_logging.enabled &&
          config.application_logging.metrics.enabled
        ) {
          // We'll try to use level labels for the metric name, but if
          // they don't exist, we'll default back to the level number.
          const levelLabel = this.levels.labels[level] || level
          newrelic.shim.agent.metrics.getOrCreateMetric('Logging/lines').incrementCallCount()
          newrelic.shim.agent.metrics
            .getOrCreateMetric(`Logging/lines/${levelLabel}`)
            .incrementCallCount()
        }
        return method.apply(this, inputArgs)
      }
    }
  }
}
*/

/**
 * Adds a supportability metric to track customers
 * using the Pino log enricher
 *
 * @param {Agent} agent New Relic agent
 */
function createModuleUsageMetric(agent) {
  agent.metrics
    .getOrCreateMetric('Supportability/ExternalModules/PinoLogEnricher')
    .incrementCallCount()
  agent.metrics.getOrCreateMetric('Supportability/Logging/Nodejs/pino/enabled').incrementCallCount()
}
