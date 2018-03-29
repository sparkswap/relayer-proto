import { BigNumber } from 'bignumber.js'
import levelup from 'levelup'
import leveldown from 'leveldown'
import path from 'path'
import EventEmitter from 'events'
import grpc from 'grpc'
const DESCRIPTOR_PATH = path.join(__dirname, 'relayer_client.proto')
const RELAYER_CLIENT_PROTO = grpc.load(DESCRIPTOR_PATH, 'proto', {
  convertFieldsToCamelCase: true,
  binaryAsBase64: true,
  longsAsStrings: true
})

const Order = {
  fromWire(json) {
    let order
    if(typeof json === 'string') {
      order = JSON.parse(json)
    } else {
      order = Object.assign({}, json)
    }

    order.baseAmount = new BigNumber(order.baseAmount)
    order.counterAmount = new BigNumber(order.counterAmount)

    if(order.fillAmount) {
      order.fillAmount = new BigNumber(order.fillAmount)
    }

    if(order.swapPreimage) {
      order.swapPreimage = Buffer.from(order.swapPreimage, 'base64')
    }

    if(order.swapHash) {
      order.swapHash = Buffer.from(order.swapHash, 'base64')
    }

    return order
  },
  toWire(obj) {
    let json = Object.assign({}, obj)

    json.baseAmount = obj.baseAmount.toFixed(0)
    json.counterAmount = obj.counterAmount.toFixed(0)

    if(obj.fillAmount) {
      json.fillAmount = obj.fillAmount.toFixed(0)
    }

    if(obj.swapPreimage) {
      json.swapPreimage = obj.swapPreimage.toString('base64')
    }

    if(obj.swapHash) {
      json.swapHash = obj.swapHash.toString('base64')
    }

    return json
  },

  toDb(obj) {
    return JSON.stringify(this.toWire(obj))
  },

  fromDb(buf) {
    return this.fromWire(buf.toString())
  }
}

class Relayer extends EventEmitter {
  constructor(storageLocation) {
    super()
    this.storage = levelup(leveldown(path.join(storageLocation, 'open')))
    this.server = new grpc.Server()
    this.server.addService(RELAYER_CLIENT_PROTO.RelayerClient.service, {
      maker: this._stream.bind(this, 'maker'),
      taker: this._stream.bind(this, 'taker'),
      subscribeOrders: this._subscribeOrders.bind(this),
      getOrders: this._getOrders.bind(this)
    })
    this._streams = {
      taker: {},
      maker: {}
    }

    // Maker
    this.on('request:placeOrder', this._wrap(this._placeOrder))
    this.on('request:cancelOrder', this._wrap(this._cancelOrder))
    this.on('request:completeOrder', this._wrap(this._completeOrder))

    // Taker
    this.on('request:fillOrder', this._wrap(this._fillOrder))
  }

  listen(host = '0.0.0.0', port = '50078') {
    this.server.bind(`${host}:${port}`, grpc.ServerCredentials.createInsecure())
    this.server.start()
  }

  _stream(type, call) {
    let orderId

    call.on('data', (msg) => {
      if(!msg.orderId) {
        return this.emit('error', new Error("Message arrived with no order id"))
      }
      if(orderId && msg.orderId !== orderId) {
        return this.emit('error', new Error("Inconsistent order ids in messages"))
      }

      orderId = msg.orderId

      // this is a foolish way of doing things... should have some authoritative way to tell
      // who the stream belongs to
      if(!this._streams[type][orderId]) {
        this._streams[type][orderId] = call
      }

      Object.keys(msg).forEach( (key) => {
        let requestType = key.slice(-1 * 'Request'.length) === 'Request' ? key.slice(0, -1 * 'Request'.length) : null
        if(requestType && msg[key] !== null) {
          this.emit(`request:${requestType}`, orderId, msg[key], this._streamCallback(call, orderId, requestType), call)
        }
      })
    })

    call.on('error', (err) => {
      // TODO
    })

    call.on('end', () => {
      // TODO
      call.end()
    })
  }

  _streamCallback(call, orderId, responseType) {
    return (err, orderStatus, message) => {
      if(err) {
        return call.emit('error', err)
      }

      if(responseType) {
        let response = {
          orderId,
          orderStatus
        }

        response[`${responseType}Response`] = message

        call.write(response)
      }
    }
  }

  _request(orderId, userType, requestType, message) {
    let call = this._streams[userType][orderId]

    let request = {
      orderId
    }

    request[`${requestType}Request`] = message

    return new Promise( (resolve, reject) => {
      if(!call) {
        return reject(new Error("No valid stream to request"))
      }

      let listener = (msg) => {
        if(msg.orderId !== orderId) {
          reject(new Error("Inconsistent order ids in messages"))
        } else if(msg[`${requestType}Response`]) {
          resolve(msg[`${requestType}Response`])
        }

        call.removeListener('data', listener)
      }

      call.on('data', listener)

      call.write(request)
    })
  }

  _wrap(fn) {
    return (orderId, request, respond, call) => {
      fn.call(this, orderId, request, call).then( (response) => {
        respond(null, ...response)
      }, (err) => {
        console.log("wire error", err)
        respond(err)
      })
    }
  }

  // This is stupidly inefficient
  _getOrders(call, callback) {
    const { baseSymbol, counterSymbol } = call.request
    let orders = []

    function finish() {
      callback(null, {
        orderUpdates: orders.filter( (order, index) => {
          const firstInstance = orders.map( order => order.orderId ).indexOf(order.orderId) === index
          const rightMarket = order.baseSymbol === baseSymbol && order.counterSymbol === counterSymbol
          const isActive = order.status === 'PLACED' || order.status === 'FILLING'

          return firstInstance && rightMarket && isActive
        }).map( (order) => {
          return {
            orderId: order.orderId,
            orderStatus: 'PLACED',
            order: {
              baseSymbol: order.baseSymbol,
              counterSymbol: order.counterSymbol,
              baseAmount: order.baseAmount,
              counterAmount: order.counterAmount,
              side: order.side
            }
          }
        })
      })
    }

    this.storage.createReadStream()
      .on('data', data => {
        const order = Object.assign(Order.fromWire(data.value), { orderId: data.key.toString('utf8') })
        orders.push(order)
      })
      .on('error', err => {
        callback(err)
      })
      .on('end', () => {
        finish()
      })
      .on('close', () => {
        finish()
      })
  }

  _subscribeOrders(call) {
    const { baseSymbol, counterSymbol } = call.request

    // Tell the peoples
    this.on('order:created', (orderId, order) => {
      if(order.baseSymbol === baseSymbol && order.counterSymbol == counterSymbol) {
        call.write({
          orderId,
          // TODO: enum of order status
          orderStatus: 'PLACED',
          order: Order.toWire({
            baseSymbol: order.baseSymbol,
            counterSymbol: order.counterSymbol,
            baseAmount: order.baseAmount,
            counterAmount: order.counterAmount,
            side: order.side
          })
        })
      }
    })
    this.on('order:cancelled', (orderId, order) => {
      if(order.baseSymbol === baseSymbol && order.counterSymbol == counterSymbol) {
        call.write({
          orderId,
          // TODO: enum of order status
          orderStatus: 'CANCELLED'
        })
      }
    })
    // filling status?
    this.on('order:filled', (orderId, order) => {
      if(order.baseSymbol === baseSymbol && order.counterSymbol == counterSymbol) {
        call.write({
          orderId,
          // TODO: enum of order status
          orderStatus: 'FILLED',
          ...Order.toWire({ fillAmount: order.fillAmount })
        })
      }
    })
  }


  async _placeOrder(orderId, request, call) {
    let order = Order.fromWire(request.order)

    validateOrder(order)

    try {
      await this.storage.get(orderId)
    } catch(e) {
      if(e.notFound) {
        await this.storage.put(orderId, Order.toDb({ ...order, status: 'PLACED' }))
        this.emit('order:created', orderId, order)
        return [ 'PLACED', {} ]
      }

      throw new Error(`Unknown error`)
    }

    throw new Error(`Order with that ID already exists`)
  }

  async _cancelOrder(orderId, request) {
    let order = await this._getOrderWithStatus(orderId, 'PLACED')

    await this.storage.put(orderId, Order.toDb({ ...order, status: 'CANCELLED' }))
    this.emit('order:cancelled', orderId, order)

    return [ 'CANCELLED', {}]
  }

  async _completeOrder(orderId, request) {
    let order = this._getOrderWithStatus(orderId, 'FILLING')

    // TODO: check that preimage matches swap hash

    await this.storage.put(orderId, Order.toDb({ ...order, swapPreimage: request.swapPreimage }))
    // emit this here or after everything is all done?
    this.emit('order:filled', orderId, order)

    return ['FILLED', {}]
  }

  async _fillOrder(orderId, request) {
    let order = await this._getOrderWithStatus(orderId, 'PLACED')

    if(!this._streams.maker[orderId]) {
      throw new Error("Order not in valid state to be filled")
    }

    await this.storage.put(orderId, Order.toDb({
      ...order,
      swapHash: request.fill.swapHash,
      fillAmount: request.fill.fillAmount,
      status: 'FILLING'
    }))
    // emit this here or after everything is all done?
    this.emit('order:filling', orderId, order)

    await this._request(orderId, 'maker', 'executeOrder', {
      fill: request.fill
    })

    return ['FILLING', { payTo: order.payTo }]
  }

  async _getOrderWithStatus(orderId, status) {
    let order;
    try {
      order = await this.storage.get(orderId)
      order = Order.fromDb(order)
    } catch(e) {
      if(e.notFound) {
        throw new Error(`No order with id ${orderId}`)
      }
      console.log("database error", e)
      throw new Error(`Unknown error`)
    }

    if(order.status !== status) {
      throw new Error("Invalid order status")
    }

    return order
  }
}

export default Relayer


function validateOrder(order) {   
  if(!['ASK', 'BID'].includes(order.side)) {
    throw new Error("Side must be either ASK or BID");
  }

  if(!BigNumber.isBigNumber(order.baseAmount) || !order.baseAmount.isInteger() || order.baseAmount.isLessThanOrEqualTo(0)) {
    throw new Error("baseAmount must be a BigNumber Integer greater than 0");
  }

  if(!BigNumber.isBigNumber(order.counterAmount) || !order.counterAmount.isInteger() || order.counterAmount.isLessThanOrEqualTo(0)) {
    throw new Error("counterAmount must be a BigNumber Integer greater than 0");
  }
}