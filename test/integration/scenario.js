"use strict"

require('./../../config/init')
var shortid = require('shortid')
var Hub = require('./../../lib/hub/hub')

var request = require('request')
var nock = require('nock')

var Bluebird = require('bluebird')
Bluebird.promisifyAll(request)

class SubscriberBuilder {
  constructor(scenario, msgType, options) {
    this.baseUrl = "http://localhost"
    this.scenario = scenario
    this.msgType = msgType
    this.options = options || {}
  }

  withConcurrency(concurrency) {
    this.concurrency = concurrency
    return this
  }
  withResponseTaking(ms) {
    this.responseTaking = ms
    return this
  }

  at(path) {
    this.path = path
    return this.scenario
  }

  buildManifest() {
    var manifest = {
      subscribes: [this.msgType],
    }
    if (this.options.retrySchedule) {
      manifest.retrySchedule = this.options.retrySchedule
    }
    if (this.path) {
      manifest.endpoint = `${this.baseUrl}${this.path}`
        .replace(':type', this.msgType)
    }

    if (this.concurrency) manifest.concurrency = this.concurrency

    return manifest
  }
}

class ScenarioBuilder {
  constructor() {
    this.basePort = 8080
    this.hubBase = `http://localhost:${this.basePort}`
    this.hubs = []
    this.testPromise = new Promise((resolve, reject) => {
      this.resolveFunction = resolve
      this.rejectFunction = reject
    })
    this.requestsMade = []
  }

  forHub(options) {
    this.options = options || {}
    return this
  }

  withSubscriber(msgType, options) {
    return this.subscriber = new SubscriberBuilder(this, msgType, options)
  }

  whenSendingMessage(msg, options) {
    this.message = msg
    this.messageOptions = options || {}
    return this
  }

  itIsReceivedAt(path, options) {
    this.receivingPath = path
    this.receivingOptions = options || {}
    return this
  }

  after(ms) {
    this.afterMillis = ms
    return this
  }

  withinSchedule() {
    this.requestsSchedule = Array.prototype.slice.call(arguments)
    return this
  }

  buildManifest() {
    var publisher = {
      publishes: [this.subscriber.msgType]
    }
    var pubName = shortid.generate()

    var subscriber = this.subscriber.buildManifest()
    var subName = shortid.generate()

    var manifest = {}
    manifest[pubName] = publisher
    manifest[subName] = subscriber

    return manifest
  }

  *sendMessages() {
    var messagesEndpoint = `${this.hubBase}/api/v1/messages`
    var times = this.messageOptions.times || 1
    for (var i = 0; i < times; i++) {
      var response = yield request.postAsync({
        url: messagesEndpoint,
        json: true,
        body: this.message
      })

      var status = response.statusCode
      if (status !== 204) throw new Error(
        `POST ${messagesEndpoint} responded with ${status}`
      )
    }
  }

  *setupMocks() {
    const maxRequests = 1e6
    const me = this
    const status = this.subscriber.options.status || 200
    var sub = this.subscriber
    var req = nock(this.subscriber.baseUrl)
      .filteringRequestBody((body) => {
        this.requestsMade.push({ body: body, ts: Date.now() })
        return body
      })
      .post(this.receivingPath)
      .times(maxRequests)
      .reply(status, function(uri, req, cb) {
        if (me.subscriber.responseTaking) {
          setTimeout(function() {
            cb(null, [status, "Delayed response"])
          }, me.subscriber.responseTaking)
        }
        else cb(null, [status, "Response"])
      })
      .log(_ => log.debug(_))
  }

  checkAssertions() {
    var requests = this.requestsMade
    var schedule = this.requestsSchedule

    // Handle the `after` constraint
    var timePassed = Date.now() - this.testStartTS
    if (this.afterMillis && timePassed < this.afterMillis) return

    // Check schedule
    if (schedule && schedule.length) {
      var threshold = 100, warmup = 100
      if (requests.length !== schedule.length) return
      var scheduleRanges = schedule.reduce((acc, delay, index) => {
        var last = acc[acc.length - 1]
        var range = last
          ? [this.testStartTS + delay, this.testStartTS + delay + threshold * index]
          : [this.testStartTS, this.testStartTS + delay + warmup]
        acc.push(range)
        return acc
      }, [])
      for (var i = 0; i < scheduleRanges.length; i++) {
        var requestTS = requests[i].ts
        var range = scheduleRanges[i]
        var fallsInRange = range[0] <= requestTS && requestTS <= range[1]
        if (!fallsInRange) {
          log.error({
            scheduleRanges: scheduleRanges.map(r => ({
              from: r[0], to: r[1],
              delta: r[1] - r[0], fromStart: r[0] - this.testStartTS
            })),
            requests: requests.map(r => ({ ts: r.ts, fromStart: r.ts - this.testStartTS })),
            startTS: this.testStartTS
          }, "Invalid request ranges")
          this.rejectFunction(
            `#${i} ${requestTS} doesn't fall in [${range[0]}..${range[1]}]`
          )
          return
        }
      }
      this.resolveFunction()
      return
    }

    // Check simple requests count
    var expectedRequestsCount = this.receivingOptions.times || 1
    var requestCountsMatch = requests.length === expectedRequestsCount
    if (this.afterMillis) {
      if (requestCountsMatch) {
        this.resolveFunction()
      }
      else {
        this.rejectFunction(new Error(
          `Expected ${expectedRequestsCount}, but got ${requests.length}`
        ))
      }
    }
    else if (requestCountsMatch) {
      this.resolveFunction()
    }
  }

  *runTests() {
    this.checkAssertionsInterval = setInterval(() => this.checkAssertions(), 50)
    return this.testPromise
  }

  buildConfig(options) {
    var WebServer = require('./../../lib/middlewares/web_server')
    var API = require('./../../lib/middlewares/api')
    var OutQueue = require('./../../lib/middlewares/out_queue')
    var Dispatcher = require('./../../lib/middlewares/dispatcher')
    var InQueue = require('./../../lib/middlewares/in_queue')
    var Delivery = require('./../../lib/middlewares/delivery')
    var ErrorHandler = require('./../../lib/middlewares/error_handler')
    var Scheduler = require('./../../lib/middlewares/scheduler')
    var DeadLetter = require('./../../lib/middlewares/dead_letter')
    // Used for launching multiple hub instances
    var port = this.basePort + (options.instanceNumber || 0)
    return {
      middlewares: [
        { type: WebServer, params: { port: port } },
        { type: API },
        { type: OutQueue },
        { type: Dispatcher },
        { type: InQueue },
        { type: Delivery },
        { type: Scheduler },
        { type: ErrorHandler },
        { type: DeadLetter },
      ]
    }
  }

  *run() {
    var manifest = this.buildManifest()
    log.debug({ manifest: manifest }, "Manifest generated")
    var numInstances = this.options.instances || 1
    this.hubs = []
    for (var i = 0; i < numInstances; i++) {
      var hub = new Hub({
        manifest: manifest,
        config: this.buildConfig({instanceNumber: i})
      })
      this.hubs.push(hub)
    }
    yield this.hubs.map(_ => _.run())
    yield this.setupMocks()
    this.testStartTS = Date.now()
    yield this.sendMessages()
    return yield this.runTests()
  }

  *reset() {
    yield this.hubs.map(_ => _.purge())
    yield this.hubs.map(_ => _.stop())
    this.hubs = []
    if (this.checkAssertionsInterval)
      clearInterval(this.checkAssertionsInterval)
  }
}

module.exports = function() {
  return new ScenarioBuilder()
}
