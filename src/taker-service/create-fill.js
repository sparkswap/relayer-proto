const { Order, Fill, FeeInvoice } = require('../models')
const { generateInvoices, Big } = require('../utils')
const { FailedToCreateFillError } = require('../errors')
const { PublicError } = require('grpc-methods')

/**
 * Given an order and set of params, creates a pending fill
 *
 * @param {GrpcUnaryMethod~request} request - request object
 * @param {Object} request.params - Request parameters from the client
 * @param {Object} request.logger - logger for messages about the method
 * @param {EventEmitter} request.eventHandler - Event bus to put order messages onto
 * @param {Object} responses
 * @param {function} responses.CreateFillResponse - constructor for CreateFillResponse messages
 * @return {responses.CreateFillResponse}
 */
async function createFill ({ params, logger, eventHandler, engine }, { CreateFillResponse }) {
  const {
    orderId,
    swapHash,
    fillAmount,
    takerPayTo
  } = params

  const safeParams = {
    orderId: String(orderId),
    swapHash: Buffer.from(swapHash, 'base64'),
    fillAmount: Big(fillAmount)
  }

  const order = await Order.findOne({ orderId: safeParams.orderId })

  if (!order) {
    throw new Error(`No order exists with Order ID ${safeParams.orderId}.`)
  }

  if (order.status !== Order.STATUSES.PLACED) {
    throw new Error(`Order ID ${safeParams.orderId} is not in a state to be filled.`)
  }

  if (Big(fillAmount).gt(Big(order.baseAmount))) {
    throw new PublicError(`Fill amount is larger than order baseAmount for Order ID ${safeParams.orderId}.`)
  }

  try {
    var fill = await Fill.create({
      order_id: order._id,
      swapHash: safeParams.swapHash,
      fillAmount: safeParams.fillAmount,
      takerPayTo: takerPayTo
    })
  } catch (err) {
    throw new FailedToCreateFillError(err)
  }

  logger.info('createFill: Fill has been created', { orderId: order.orderId, fillId: fill.fillId })

  try {
    var [depositInvoice, feeInvoice] = await generateInvoices(fill.fillAmount, fill.fillId, fill._id, engine, FeeInvoice.FOREIGN_TYPES.FILL, logger)
  } catch (err) {
    throw new FailedToCreateFillError(err)
  }

  logger.info('createFill: Invoices have been created through Relayer', {
    deposit: depositInvoice._id,
    fee: feeInvoice._id
  })

  eventHandler.emit('fill:created', fill)
  logger.info('fill:created', { fillId: fill.fillId })

  return new CreateFillResponse({
    fillId: fill.fillId,
    depositPaymentRequest: depositInvoice.paymentRequest,
    feePaymentRequest: feeInvoice.paymentRequest
  })
}

module.exports = createFill
