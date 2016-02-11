"use strict"

var Redis = require('./redis')
var shortid = require('shortid')
var _ = require('lodash')

class ConcurrencyManager extends Redis {
  constructor(options) {
    super(options)

    this.defineMandatoryDependency('in_queue', 'inQueue', this.service)
    this.defineMandatoryDependency('out_queue', 'outQueue', this.service)
    this.pollingIntervalMillis = this.params.pollingIntervalMillis || 5000
    this.redisKey = `hub_${this.service.name}_alive`
    this.processId = shortid.generate()
  }

  *start() {
    yield *super.start()

    yield this.reportImAlive()
    yield this.outQueue.setConcurrency(0)
    // yield this.adjustConcurrency()
    this.interval = setInterval(() => {
      co(function*() {
        yield this.adjustConcurrency()
      }.bind(this))
      .catch(_ => log.error(_))
    }, this.pollingIntervalMillis)
  }

  *reportImAlive() {
    var now = Date.now()
    log.debug({ now: now, key: this.redisKey }, "I'm alive")
    yield this.client.zaddAsync(this.redisKey, now, this.processId)
  }

  *getNumberOfAliveProcesses() {
    var now = Date.now()
    var start = now - this.pollingIntervalMillis
    var end = now + 1
    var results = yield this.client.zrangebyscoreAsync(this.redisKey, start, end)
    if (results.length === 0) {
      log.debug({
        results: results,
        start: start,
        end: end
      }, "No live processes found - will use max concurrency")
      return 1
    }
    return _.uniq(results).length
  }

  *adjustConcurrency() {
    if (this.stopped) return

    log.debug("Checking concurrency")
    yield this.reportImAlive()
    var aliveProcesses = yield this.getNumberOfAliveProcesses()
    log.debug({
      aliveProcesses: aliveProcesses,
      pollingIntervalMillis: this.pollingIntervalMillis
    }, "Adjusting concurrency")
    var singleReaderConcurrency = this.service.concurrency * 1.0 / aliveProcesses
    yield this.inQueue.setConcurrency(singleReaderConcurrency)
  }

  *stop() {
    yield *super.stop()
    this.stopped = true
    if (this.interval) {
      clearInterval(this.interval)
    }
  }
}

module.exports = ConcurrencyManager