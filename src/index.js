'use strict'
global.Buffer = global.Buffer || require('buffer').Buffer

const _ = require('lodash')
const { EventEmitter } = require('events')
const StreamSpeed = require('streamspeed')

// var performance = {
//   speed: 0,
//   now: () => {
//     return performance.speed
//   }
// }
console.log('npm linked :)3, perforamnce: ', performance.now())

class HlsjsIPFSLoader extends EventEmitter {
  constructor (config) {
    super()
    this.ipfs = config.ipfs
    this.hash = config.ipfsHash
    this.gateway = config.gateway || 'https://gateway.paratii.video'
    this.emitter = config.emitter || this
    this.DAG = config.dag || null
    this.peers = []
    // console.log('-------------------------DAG---------------------\n', this.DAG)
    if (this.ipfs && this.ipfs.isOnline()) {
      // this.getDAG(() => {
      //   console.log('HLSjs IPFS LOADER READY')
      // })

      this.getPeersArray((err, peers) => {
        if (err) return console.log('hlsjs getPeersArray Error ', err)
        this.peers = peers
      })
    }
  }

  destroy () {
    console.log('hlsjs-ipfs-loader DESTROY')
    this.emitter.emit('loader-status', {
      timestamp: Date.now(),
      event: 'destroy'
    })
  }

  abort () {
    console.log('hlsjs-ipfs-loader ABORTED')
    this.emitter.emit('loader-status', {
      timestamp: Date.now(),
      event: 'abort'
    })
  }

  load (context, config, callbacks) {
    this.context = context
    if (this.context && !this.context.progressData) {
      this.context.progressData = true
    }
    console.log('context: ', this.context)
    this.config = config
    this.callbacks = callbacks
    this.stats = { trequest: performance.now(), retry: 0 }
    this.retryDelay = config.retryDelay
    this.loadInternal()
    this.emitter.emit('loader-status', {
      timestamp: Date.now(),
      event: 'loading-internals'
    })
  }

  loadInternal () {
    var stats = this.stats, context = this.context, config = this.config, callbacks = this.callbacks

    stats.tfirst = Math.max(performance.now(), stats.trequest)
    stats.loaded = 0
    console.log('performance: ', performance)

    var urlParts = context.url.split('/')
    var filename = urlParts[urlParts.length - 1]
    // console.log('this.DAG: ', this.DAG, '\nthis.peers: ', this.peers)
    if (this.ipfs && this.ipfs.isOnline()) { // && this.peers.length > 7) {
      // this.getDAG(() => {
      this.catFile('/ipfs/' + this.hash + '/' + filename, (err, res) => {
        if (err) {
          console.log(err)
          return
        }

        var data, len
        if (res) {
          if (context.responseType === 'arraybuffer') {
            console.log('response: ', res)
            data = res
            len = res.length
          } else {
            data = buf2str(res)
            len = data.length
          }
        }
        stats.loaded = stats.total = len
        stats.tload = Math.max(stats.tfirst, performance.now())
        console.log('performance: ', performance.now())

        var response = { url: context.url, data: data }
        callbacks.onSuccess(response, stats, context)
      })
      // })
    } else {
      this.getFileXHR(this.hash, filename)
    }
  }

  getFileXHR (rootHash, filename, callback) {
    // if (!callback) callback = function (err, res) {}
    console.log('XHR hash for \'' + rootHash + '/' + filename + '\'')

    let xhr = new XMLHttpRequest()
    let context = this.context
    try {
      xhr.open('GET', this.gateway + '/ipfs/' + rootHash + '/' + filename, true)
    } catch (e) {
      this.callbacks.onError({ code: xhr.status, text: e.message }, context, xhr)
      // callback({ code: xhr.status, text: e.message })
    }

    if (context.rangeEnd) {
      xhr.setRequestHeader('Range', 'bytes=' + context.rangeStart + '-' + (context.rangeEnd-1));
    }

    xhr.onreadystatechange = this.readystatechange.bind(this)
    xhr.onprogress = this.loadprogress.bind(this)
    xhr.responseType = context.responseType

    // setup timeout before we perform request
    this.requestTimeout = window.setTimeout(this.loadtimeout.bind(this), this.config.timeout)
    xhr.send()
  }

  readystatechange(event) {
    var xhr = event.currentTarget,
        readyState = xhr.readyState,
        stats = this.stats,
        context = this.context,
        config = this.config;

    // don't proceed if xhr has been aborted
    if (stats.aborted) {
      return;
    }

    // >= HEADERS_RECEIVED
    if (readyState >=2) {
      // clear xhr timeout and rearm it if readyState less than 4
      window.clearTimeout(this.requestTimeout)
      if (stats.tfirst === 0) {
        stats.tfirst = Math.max(performance.now(), stats.trequest)
      }
      if (readyState === 4) {
        let status = xhr.status;
        // http status between 200 to 299 are all successful
        if (status >= 200 && status < 300)  {
          stats.tload = Math.max(stats.tfirst, performance.now())
          let data,len
          if (context.responseType === 'arraybuffer') {
            data = xhr.response
            len = data.byteLength
          } else {
            data = xhr.responseText
            len = data.length
          }

          stats.loaded = stats.total = len
          let response = { url: xhr.responseURL, data: data }
          this.callbacks.onSuccess(response, stats, context, xhr)
        } else {
            // if max nb of retries reached or if http status between 400 and 499 (such error cannot be recovered, retrying is useless), return error
          if (stats.retry >= config.maxRetry || (status >= 400 && status < 499)) {
            console.error(`${status} while loading ${context.url}`)
            this.callbacks.onError({code: status, text: xhr.statusText}, context, xhr)
          } else {
            // retry
            console.warn(`${status} while loading ${context.url}, retrying in ${this.retryDelay}...`)
            // aborts and resets internal state
            this.destroy()
            // schedule retry
            this.retryTimeout = window.setTimeout(this.loadInternal.bind(this), this.retryDelay)
            // set exponential backoff
            this.retryDelay = Math.min(2 * this.retryDelay, config.maxRetryDelay)
            stats.retry++
          }
        }
      } else {
        // readyState >= 2 AND readyState !==4 (readyState = HEADERS_RECEIVED || LOADING) rearm timeout as xhr not finished yet
        this.requestTimeout = window.setTimeout(this.getFileXHR.bind(this), config.timeout)
      }
    }
  }

  loadtimeout () {
    console.warn(`timeout while loading ${this.context.url}`)
    this.emitter.emit('loader-status', {
      timestamp: Date.now(),
      event: 'timeout',
      stats: this.stats,
      context: this.context
    })
    this.callbacks.onTimeout(this.stats, this.context, null)
  }

  loadprogress (event) {
    var xhr = event.currentTarget
    let stats = this.stats

    stats.loaded = event.loaded
    if (event.lengthComputable) {
      stats.total = event.total
    }
    let onProgress = this.callbacks.onProgress
    if (onProgress) {
      this.emitter.emit('loader-status', {
        timestamp: Date.now(),
        event: 'progress',
        stats: stats,
        context: this.context
      })
      // third arg is to provide on progress data
      onProgress(stats, this.context, null, xhr)
    }
  }

  getDAG (callback) {
    if (!callback) callback = () => {}
    if (!this.ipfs) {
      return callback(null)
    }

    if (this.DAG && this.DAG !== null) {
      console.log('dag is already availlable')
      return callback(null, this.DAG)
    }
    // console.log('getting Object DAG ' + this.hash)
    this.ipfs.object.get(this.hash, (err, res) => {
      if (err) throw err
      this.DAG = res.links
      this.emitter.emit('loader-status', {
        timestamp: Date.now(),
        event: 'DAG',
        DAG: res.links
      })

      callback(null, res.links)
    })
  }

  getPeersArray (callback) {
    if (!callback) callback = () => {}
    if (!this.ipfs) {
      return callback(null)
    }

    this.ipfs.swarm.peers((err, peers) => {
      if (err) {
        return callback(err)
      }

      this.peers = peers
      callback(null, peers)
    })
  }

  getFileInfo (filename) {
    if (!filename) {
      return
    }

    var hash = null
    var fileSize, fileName

    _.each(this.DAG, (link) => {
      if (link.name === filename) {
        hash = link.multihash
        fileSize = link.size
        fileName = link.name
        return false
      }
    })

    return {hash, fileSize, fileName}
  }

  catFile (filename, callback) {
    if (!callback) callback = () => {}
    // var {hash, fileSize, fileName} = this.getFileInfo(filename)

    console.log('Fetching hash for \'' + filename + '\'')

    // if (!hash) {
    //   var msg = 'File not found: ' + this.hash + '/' + filename
    //   return callback(new Error(msg), null)
    // }

    console.log('Requesting \'' + filename + '\'')

    var resBuf = null
    // var bufView = new Uint8Array()
    var offs = 0
    // var ss = new StreamSpeed()

    const stream = this.ipfs.files.catReadableStream(filename)

    // this.ipfs.files.cat(hash, (err, stream) => {
    //   // ss.add(stream)
    //   //
    //   // // Listen for events emitted by streamspeed on the given stream.
    //   // ss.on('speed', (speed, avgSpeed) => {
    //   //   console.log('Reading at', speed, 'bytes per second')
    //   //   // performance.speed = speed
    //   //
    //   //   this.emitter.emit('loader-status', {
    //   //     timestamp: Date.now(),
    //   //     event: 'speed',
    //   //     speed: speed,
    //   //     avgSpeed: avgSpeed
    //   //   })
    //   // })
    //
    //   console.log('Received stream for file \'' + this.hash + '/' + fileName + '\'')
    //   if (err) return callback(err)
    // })
    stream.on('data', (chunk) => {
      console.log('Received ' + chunk.length + ' bytes for file \'' +
      filename + '\'')
      if (Buffer.isBuffer(resBuf)) {
        resBuf = Buffer.concat([resBuf, chunk])
      } else {
        resBuf = Buffer.from(chunk)
      }
      // bufView.set(chunk, offs)
      offs += chunk.length
      this.loadprogress({
        currentTarget: filename,
        loaded: offs
      })
    })

    // stream.on('data', this.loadprogress.bind(this))

    stream.on('error', (err) => {
      callback(err, null)
    })

    stream.on('end', () => {
      console.log('STREAM ENDED, resBuf Length: ', resBuf)
      callback(null, resBuf)
    })
  }
}

// function getFile(ipfs, rootHash, filename, callback) {
//   if (!callback) callback = function (err, res) {}
//   console.log('Fetching hash for '' + rootHash + '/' + filename + ''')
//   ipfs.object.get(rootHash, function(err, res) {
//     if (err) return callback(err)
//
//     var hash = null
//     var fileSize, fileName
//
//     _.each(res.links, function(link) {
//       if (link.name === filename) {
//         hash = link.multihash
//         fileSize = link.size
//         fileName = link.name
//         return false
//       }
//     });
//
//     if (!hash) {
//       var msg = 'File not found: ' + rootHash + '/' + filename
//       return callback(new Error(msg), null)
//     }
//
//     console.log('Requesting '' + rootHash + '/' + filename + ''')
//
//     var resBuf = new ArrayBuffer(fileSize)
//     var bufView = new Uint8Array(resBuf)
//     var offs = 0
//
//     ipfs.files.cat(hash, function (err, stream) {
//       console.log('Received stream for file '' + rootHash + '/' +
//         fileName + ''')
//       if (err) return callback(err)
//       stream.on('data', function (chunk) {
//         console.log('Received ' + chunk.length + ' bytes for file '' +
//           rootHash + '/' + fileName + ''')
//         bufView.set(chunk, offs)
//         offs += chunk.length
//       });
//       stream.on('error', function (err) {
//         callback(err, null)
//       });
//       stream.on('end', function () {
//         callback(null, resBuf)
//       });
//     })
//   });
// }

// function getFile(ipfs, rootHash, filename, callback) {
//   if (!callback) callback = function (err, res) {}
//   console.log('Fetching hash for '' + rootHash + '/' + filename + ''')
//   ipfs.object.get(rootHash, function(err, res) {
//     if (err) return callback(err)
//
//     var hash = null
//     var fileSize, fileName
//
//     _.each(res.links, function(link) {
//       if (link.name === filename) {
//         hash = link.multihash
//         fileSize = link.size
//         fileName = link.name
//         return false
//       }
//     });
//
//     if (!hash) {
//       var msg = 'File not found: ' + rootHash + '/' + filename
//       return callback(new Error(msg), null)
//     }
//
//     console.log('Requesting '' + rootHash + '/' + filename + ''')
//
//     var resBuf = new ArrayBuffer(fileSize)
//     var bufView = new Uint8Array(resBuf)
//     var offs = 0
//
//     ipfs.files.cat(hash, function (err, stream) {
//       console.log('Received stream for file '' + rootHash + '/' +
//         fileName + ''')
//       if (err) return callback(err)
//       stream.on('data', function (chunk) {
//         console.log('Received ' + chunk.length + ' bytes for file '' +
//           rootHash + '/' + fileName + ''')
//         bufView.set(chunk, offs)
//         offs += chunk.length
//       });
//       stream.on('error', function (err) {
//         callback(err, null)
//       });
//       stream.on('end', function () {
//         callback(null, resBuf)
//       });
//     })
//   });
// }

function buf2str (buf) {
  return String.fromCharCode.apply(null, new Uint8Array(buf))
}

exports = module.exports = HlsjsIPFSLoader
