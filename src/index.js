'use strict'

const _ = require('lodash')

class HlsjsIPFSLoader {
  constructor(config) {
    this.ipfs = config.ipfs
    this.hash = config.ipfsHash
  }

  destroy() {
  }

  abort() {
  }

  load(context, config, callbacks) {
    this.context = context
    this.config = config
    this.callbacks = callbacks
    this.stats = { trequest: performance.now(), retry: 0 }
    this.retryDelay = config.retryDelay
    this.loadInternal()
  }

  loadInternal() {
    var stats = this.stats,
        context = this.context,
        config = this.config,
        callbacks = this.callbacks

    stats.tfirst = Math.max(performance.now(), stats.trequest)
    stats.loaded = 0

    var urlParts = context.url.split("/")
    var filename = urlParts[urlParts.length - 1]
    if (this.ipfs && this.ipfs.isOnline()) {
      getFile(this.ipfs, this.hash, filename, function(err, res) {
        if (err) {
          console.log(err);
          return
        }

        var data,len
        if (context.responseType === 'arraybuffer') {
          data = res
          len = res.length
        } else {
          data = buf2str(res)
          len = data.length
        }
        stats.loaded = stats.total = len
        stats.tload = Math.max(stats.tfirst, performance.now())
        var response = { url: context.url, data: data }
        callbacks.onSuccess(response, stats, context)
      })

    } else {
      this.getFileXHR(this.hash, filename)

    }
  }

  getFileXHR (rootHash, filename, callback) {
    // if (!callback) callback = function (err, res) {}
    console.log("XHR hash for '" + rootHash + "/" + filename + "'")

    let xhr = new XMLHttpRequest()
    let context = this.context
    try {
      xhr.open('GET', 'http://localhost:9090/ipfs/'+rootHash+'/'+filename, true)
    } catch (e) {
      this.callbacks.onError({ code : xhr.status, text: e.message }, context, xhr)
      // callback({ code: xhr.status, text: e.message })
    }

    if (context.rangeEnd) {
      xhr.setRequestHeader('Range','bytes=' + context.rangeStart + '-' + (context.rangeEnd-1));
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
          stats.tload = Math.max(stats.tfirst,performance.now())
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
      // third arg is to provide on progress data
      onProgress(stats, this.context, null, xhr)
    }
  }
}

// function getFile(ipfs, rootHash, filename, callback) {
//   if (!callback) callback = function (err, res) {}
//   console.log("Fetching hash for '" + rootHash + "/" + filename + "'")
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
//       var msg = "File not found: " + rootHash + "/" + filename
//       return callback(new Error(msg), null)
//     }
//
//     console.log("Requesting '" + rootHash + "/" + filename + "'")
//
//     var resBuf = new ArrayBuffer(fileSize)
//     var bufView = new Uint8Array(resBuf)
//     var offs = 0
//
//     ipfs.files.cat(hash, function (err, stream) {
//       console.log("Received stream for file '" + rootHash + "/" +
//         fileName + "'")
//       if (err) return callback(err)
//       stream.on('data', function (chunk) {
//         console.log("Received " + chunk.length + " bytes for file '" +
//           rootHash + "/" + fileName + "'")
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

function getFile(ipfs, rootHash, filename, callback) {
  if (!callback) callback = function (err, res) {}
  console.log("Fetching hash for '" + rootHash + "/" + filename + "'")
  ipfs.object.get(rootHash, function(err, res) {
    if (err) return callback(err)

    var hash = null
    var fileSize, fileName

    _.each(res.links, function(link) {
      if (link.name === filename) {
        hash = link.multihash
        fileSize = link.size
        fileName = link.name
        return false
      }
    });

    if (!hash) {
      var msg = "File not found: " + rootHash + "/" + filename
      return callback(new Error(msg), null)
    }

    console.log("Requesting '" + rootHash + "/" + filename + "'")

    var resBuf = new ArrayBuffer(fileSize)
    var bufView = new Uint8Array(resBuf)
    var offs = 0

    ipfs.files.cat(hash, function (err, stream) {
      console.log("Received stream for file '" + rootHash + "/" +
        fileName + "'")
      if (err) return callback(err)
      stream.on('data', function (chunk) {
        console.log("Received " + chunk.length + " bytes for file '" +
          rootHash + "/" + fileName + "'")
        bufView.set(chunk, offs)
        offs += chunk.length
      });
      stream.on('error', function (err) {
        callback(err, null)
      });
      stream.on('end', function () {
        callback(null, resBuf)
      });
    })
  });
}

function buf2str(buf) {
  return String.fromCharCode.apply(null, new Uint8Array(buf))
}

exports = module.exports = HlsjsIPFSLoader
