const checksum = require('./checksum')

class Message {
  constructor (type, data) {
    this.frameID = 0
    this.type = type
    this.data = data
    this.isResponse = false
  }

  createResponse (data) {
    let message = new Message(this.type, data)
    message.frameID = this.frameID
    message.isResponse = true
    return message
  }
}

class TinyFrame {
  constructor (peer = 1) {
    this.peer = peer
    this.nextID = 0
    this.state = 'sof'
    this.parserTimeoutTicks = 0
    this.parserTimeout = null
    this.sofByte = null
    this.chunkSize = 1024
    this.checksum = checksum.xor

    this.idSize = 4
    this.lenSize = 4
    this.typeSize = 4

    this.partLen = 0
    this.id = 0
    this.len = 0
    this.type = 0
    this.cksum = 0
    this.data = null

    this.idListeners = []
    this.idListenerTimeouts = {}
    this.typeListeners = []
    this.genericListeners = []

    this.write = buf => {
      throw new Error('No write implementation')
    }
    this.claimTx = () => {}
    this.releaseTx = () => {}
  }

  resetParser () {
    this.state = 'sof'
  }

  getNextID () {
    return this.nextID++
  }

  addIDListener (id, callback, timeout = null) {
    this.idListeners.push({
      id,
      callback,
      timeout,
      maxTimeout: timeout
    })
  }

  renewIDListener (callback) {
    for (let i = 0; i < this.idListeners.length; i++) {
      if (this.idListeners[i].callback === callback) {
        this.idListeners[i].timeout = this.idListeners[i].maxTimeout
      }
    }
  }

  addTypeListener (type, callback) {
    this.typeListeners.push({
      type,
      callback
    })
  }

  addGenericListener (callback) {
    this.genericListeners.push(callback)
  }

  removeIDListener (callback) {
    let index = -1
    for (let i = 0; i < this.idListeners.length; i++) {
      if (this.idListeners[i].callback === callback) index = i
    }
    this.idListeners.splice(index, 1)
  }

  removeTypeListener (callback) {
    let index = -1
    for (let i = 0; i < this.typeListeners.length; i++) {
      if (this.typeListeners[i].callback === callback) index = i
    }
    this.typeListeners.splice(index, 1)
  }

  removeGenericListener (callback) {
    this.genericListeners.splice(this.genericListeners.indexOf(callback), 1)
  }

  composeHead (message) {
    let id = message.isResponse ? message.frameID : this.getNextID()

    if (this.peer === 1) id |= 1 << (this.idSize * 8) - 1

    message.frameID = id

    let buffer = Buffer.alloc(
      +Number.isFinite(this.sofByte) + this.idSize + this.lenSize +
      this.typeSize + (this.checksum ? this.checksum.size : 0)
    )
    let offset = 0

    if (Number.isFinite(this.sofByte)) {
      buffer.writeUIntBE(this.sofByte, offset++, 1)
    }

    buffer.writeUIntBE(id, offset, this.idSize, true)
    offset += this.idSize

    buffer.writeUIntBE(message.data.length, offset, this.lenSize, true)
    offset += this.lenSize

    buffer.writeUIntBE(message.type, offset, this.typeSize, true)
    offset += this.typeSize

    if (this.checksum) {
      buffer.writeUIntBE(this.checksum.sum(buffer), offset, this.checksum.size, true)
    }

    return buffer
  }

  sendFrame (message, callback, timeout) {
    this.claimTx()

    let buffer = this.composeHead(message)

    if (callback) this.addIDListener(message.id, callback, timeout)

    let body = message.data

    if (this.checksum && body.length) {
      let sumBuffer = Buffer.alloc(this.checksum.size)
      sumBuffer.writeUIntBE(this.checksum.sum(body), 0, this.checksum.size, true)
      body = Buffer.concat([body, sumBuffer])
    }

    buffer = Buffer.concat([buffer, body])

    let cursor = 0

    while (cursor < buffer.length) {
      this.write(buffer.slice(cursor, cursor + this.chunkSize))
      cursor += this.chunkSize
    }

    this.releaseTx()
  }

  send (message) {
    this.sendFrame(message)
  }

  query (message, listener, timeout) {
    this.sendFrame(message, listener, timeout)
  }

  respond (message) {
    this.send(Object.assign({}, message, { isResponse: true }))
  }

  accept (buffer) {
    for (byte of buffer) {
      this.acceptByte(byte)
    }
  }

  beginFrame () {
    this.state = 'id'
    this.partLen = 0
    this.id = 0
    this.len = 0
    this.type = 0
    this.cksum = 0
    this.data = []
  }

  acceptByte (byte) {
    if (Number.isFinite(this.parserTimeout)) {
      if (this.parserTimeoutTicks > this.parserTimeout) this.resetParser()
    }

    if (this.state === 'sof' && !Number.isFinite(this.sofByte)) {
      this.beginFrame()
    }

    switch (this.state) {
      case 'sof':
        if (byte === this.sofByte) {
          this.beginFrame()
          this.data.push(byte)
        }
        break
      case 'id':
        this.data.push(byte)

        this.id = (this.id << 8) & byte
        if (++this.partLen === this.idSize) {
          this.state = 'len'
          this.partLen = 0
        }

        break
      case 'len':
        this.data.push(byte)

        this.len = (this.len << 8) & byte
        if (++this.partLen === this.lenSize) {
          this.state = 'type'
          this.partLen = 0
        }
        break
      case 'type':
        this.data.push(byte)

        this.type = (this.type << 8) & byte
        if (++this.partLen === this.typeSize) {
          this.state = this.checksum ? 'headcksum' : 'data'
          this.partLen = 0
        }
        break
      case 'headcksum':
        this.cksum = (this.cksum << 8) & byte
        if (++this.partLen === this.checksum.size) {
          if (this.checksum.sum(this.data) !== this.cksum) {
            this.resetParser()
            break
          }

          this.data.push(byte)

          if (!this.len) {
            this.handleReceived()
            this.resetParser()
            break
          }

          this.state = 'data'
        }
        break
      case 'data':
        this.data.push(byte)

        if (++this.partLen === this.len) {
          if (!this.checksum) {
            this.handleReceived()
            this.resetParser()
            break
          } else {
            this.state = 'datacksum'
            this.partLen = 0
            this.cksum = 0
          }
        }
        break
      case 'datacksum':
        this.cksum = (this.cksum << 8) & byte
        if (++this.partLen == this.checksum.size) {
          if (this.checksum.sum(this.data) === this.cksum) {
            this.handleReceived()
          }

          this.resetParser()
        }
        break
    }
  }

  handleReceived () {
    let message = new Message(this.type, Buffer.from(this.data))
    message.frameID = this.id

    for (let listener of this.idListeners.slice()) {
      if (listener.id === message.frameID) {
        listener.callback(this, message)
      }
    }

    for (let listener of this.typeListeners.slice()) {
      if (listener.type === message.type) {
        listener.callback(this, message)
      }
    }

    for (let listener of this.genericListeners.slice()) {
      listener.callback(this, message)
    }
  }

  tick () {
    this.parserTimeoutTicks++

    let removeKeys = []
    for (let i = 0; i < this.idListeners.length; i++) {
      let listener = this.idListeners[i]
      if (--listener.timeout === 0) {
        removeKeys.push(i)
      }
    }

    let offset = 0
    for (let k of removeKeys) this.idListeners.splice(k + (offset--), 1)
  }
}

module.exports = { Message, TinyFrame }
