const { Order, FeeRefundInvoice, DepositRefundInvoice } = require('../models')
const { PublicError } = require('../errors')
/**
 * Cancel an order given an ID
 *
 * @param {GrpcUnaryMethod~request} request - request object
 * @param {Object} request.params - Request parameters from the client
 * @param {EventEmitter} request.eventHandler - Event bus to put order messages onto
 * @param {Object} responses
 * @param {function} responses.CancelOrderResponse - constructor for CancelOrderResponse messages
 * @return {responses.CancelOrderResponse}
 */
async function cancelOrder ({ params, eventHandler, logger, engine }) {
  const { orderId } = params
  const order = await Order.findOne({ orderId })

  if (!order) {
    logger.info(`Could not find order with orderId: ${orderId}`)
    throw new PublicError(`Could not find order with orderId: ${orderId}`)
  }

  logger.info('Cancelling order', orderId)

  // TODO: ensure this user is authorized to cancel this order
  await order.cancel()

  eventHandler.emit('order:cancelled', order)

  logger.info('Order has been cancelled', orderId)
  logger.info('Refunding started', orderId)

  const [feeRefundInvoice, depositRefundInvoice] = await Promise.all([
    FeeRefundInvoice.findOne({ foreignId: order._id }),
    DepositRefundInvoice.findOne({ foreignId: order._id })
  ])

  if (feeRefundInvoice && depositRefundInvoice) {
    if (!feeRefundInvoice.paid()) {
      const feePreimage = await engine.payInvoice(feeRefundInvoice.paymentRequest)
      await feeRefundInvoice.markAsPaid(feePreimage)
    }

    if (!depositRefundInvoice.paid()) {
      const depositPreimage = await engine.payInvoice(depositRefundInvoice.paymentRequest)
      depositRefundInvoice.markAsPaid(depositPreimage)
    }

    logger.info('Refunding complete', orderId)
  } else {
    logger.info('Invoices do not exist yet, could not refund', orderId)
  }

  return {}
}

module.exports = cancelOrder
