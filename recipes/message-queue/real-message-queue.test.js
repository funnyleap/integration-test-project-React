const axios = require('axios');
const sinon = require('sinon');
const nock = require('nock');
const { once } = require('events');
const amqplib = require('amqplib');
const messageQueueClient = require('../../example-application/libraries/message-queue-client');
const testHelpers = require('./test-helpers');
const orderRepository = require('../../example-application/data-access/order-repository');

const {
  getNextMQConfirmation,
  startFakeMessageQueue,
  getMQMessageOrTimeout,
  getShortUnique,
} = require('./test-helpers');
const {
  FakeMessageQueueProvider,
} = require('../../example-application/libraries/fake-message-queue-provider');

const {
  initializeWebServer,
  stopWebServer,
} = require('../../example-application/entry-points/api');

let axiosAPIClient, mqClient, deleteOrderPerTestQueue;

beforeAll(async (done) => {
  // ️️️✅ Best Practice: Place the backend under test within the same process
  const apiConnection = await initializeWebServer();

  // ️️️✅ Best Practice: Ensure that this component is isolated by preventing unknown calls
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
  const axiosConfig = {
    baseURL: `http://127.0.0.1:${apiConnection.port}`,
    validateStatus: () => true, //Don't throw HTTP exceptions. Delegate to the tests to decide which error is acceptable
  };
  axiosAPIClient = axios.create(axiosConfig);

  // TODO: I don't like this global initialization
  mqClient = new messageQueueClient(amqplib);
  mqClient.assertExchange('order.events', 'topic');

  done();
});

beforeEach(async () => {
  nock('http://localhost/user/').get(`/1`).reply(200, {
    id: 1,
    name: 'John',
  });
  nock('http://mail.com').post('/send').reply(202);
});

afterEach(async () => {
  nock.cleanAll();
  sinon.restore();
});

afterAll(async (done) => {
  // ️️️✅ Best Practice: Clean-up resources after each run
  await stopWebServer();
  //await messageQueueClient.close();
  nock.enableNetConnect();
  done();
});

// Playground
test('When a message is poisoned, then its rejected and put back to queue', async () => {
  // Arrange
  deleteOrderPerTestQueue = await testHelpers.createQueueForTest(
    'user-events',
    'user-deleted',
    'user.deleted'
  );
  mqClient.setRequeue(false);

  // Act
  await mqClient.publish(deleteOrderPerTestQueue.exchangeName, 'user.deleted', {
    invalidField: 'invalid-value',
  });

  // Assert
});

test('When a delete message fails ONCE, than thanks to retry the order is deleted', async () => {
  // Arrange
  const addedOrderId = await testHelpers.addNewOrder(axiosAPIClient);
  deleteOrderPerTestQueue = await testHelpers.createQueueForTest(
    'user-events',
    'user-deleted', // TODO - THE EVENTS ARE ALL ABOUT USERS BUT THE CODE IS ABOUT ORDER BEING DELETED
    'user.deleted'
  );
  const messageQueueClient = await testHelpers.startMQSubscriber(
    'real',
    deleteOrderPerTestQueue.queueName
  );
  const deleteOrderStub = sinon.stub(orderRepository.prototype, 'deleteOrder');
  deleteOrderStub.onFirstCall().rejects(new Error('Cant delete order')); // Fail only once
  orderRepository.prototype.deleteOrder.callThrough(); // Then on retry succeed

  // Act
  await messageQueueClient.publish(
    deleteOrderPerTestQueue.exchangeName,
    'user.deleted',
    {
      id: addedOrderId,
    }
  );

  // Assert
  await messageQueueClient.waitFor('ack', 1);
  const aQueryForDeletedOrder = await axiosAPIClient.get(
    `/order/${addedOrderId}`
  );
  expect(aQueryForDeletedOrder.status).toBe(404);
});

test('When a batch of messages has ONE poisoned message, than only one is rejected (nack)', async () => {
  // Arrange
  const addedOrderId = await testHelpers.addNewOrder(axiosAPIClient);
  deleteOrderPerTestQueue = await testHelpers.createQueueForTest(
    'user-events',
    'user-deleted',
    'user.deleted'
  );
  const messageQueueClient = await testHelpers.startMQSubscriber(
    'real',
    deleteOrderPerTestQueue.queueName
  );
  const badMessageId = getShortUnique();
  const goodMessageId = getShortUnique();
  messageQueueClient.setRequeue(false);

  // Act
  await messageQueueClient.publish(
    deleteOrderPerTestQueue.exchangeName,
    'user.deleted',
    {
      id: addedOrderId,
    },
    { messageId: goodMessageId }
  ); //good message
  await messageQueueClient.publish(
    deleteOrderPerTestQueue.exchangeName,
    'user.deleted',
    {
      nonExisting: 'invalid',
    },
    { messageId: badMessageId }
  ); // bad message

  // Assert
  const lastNackEvent = await messageQueueClient.waitFor('nack', 1);
  expect(lastNackEvent.lastEventData.properties.messageId).toBe(badMessageId);
});

test('When a message failed after x times it should move to the dead letter exchange', async () => {
  // Arrange
  const addedOrderId = await testHelpers.addNewOrder(axiosAPIClient);

  // Create dead letter exchange & queue - bind them
  const deadLetterPerTestQueue = await testHelpers.createDeadLetterQueueForTest(
    'failed-user-events',
    'failed-user-deleted',
    'failed.user.deleted'
  );

  deleteOrderPerTestQueue = await testHelpers.createQueueForTest(
    'user-events',
    'user-deleted',
    'user.deleted',
    deadLetterPerTestQueue.exchangeName,
    'failed.user.deleted'
  );

  const orderDeletedMessageQueueClient = await testHelpers.startMQSubscriber(
    'real',
    deleteOrderPerTestQueue.queueName
  );

  const failedOrderDeletedMessageQueueClient = await testHelpers.startMQSubscriber(
    'real',
    undefined,
    deadLetterPerTestQueue.queueName
  );

  const deleteOrderStub = sinon.stub(orderRepository.prototype, 'deleteOrder');
  deleteOrderStub.rejects(new Error('Cant delete order')); // Always fail

  // Act
  // Publish the message with the dead letter exchange
  await orderDeletedMessageQueueClient.publish(
    deleteOrderPerTestQueue.exchangeName,
    'user.deleted',
    { id: addedOrderId },
    { maxRetries: 2 }
  );

  // Assert

  // Wait for the message to move to the dead letter exchange

  // TODO - should we check if ack was called, we may want to check how many times the message has been requeue
  // TODO - Should be stated that we talk about the DLQ
  await failedOrderDeletedMessageQueueClient.waitFor('ack', 1);
  await orderDeletedMessageQueueClient.waitFor('ack', 2);
  const aQueryForDeletedOrder = await axiosAPIClient.get(
    `/order/${addedOrderId}`
  );

  // not deleted
  expect(aQueryForDeletedOrder.status).toBe(200);
});

test('When a message not being consumed after 2 seconds it should move to the dead letter exchange', async () => {
  // Arrange
  // Create dead letter exchange & queue - bind them
  const deadLetterPerTestQueue = await testHelpers.createDeadLetterQueueForTest(
    'failed-user-events',
    'failed-user-deleted'
  );

  // Create queue with TTL
  deleteOrderPerTestQueue = await testHelpers.createQueueForTest({
    exchangeName: 'user-events',
    queueName: 'user-deleted',
    bindingPattern: 'user.deleted',
    deadLetterExchange: deadLetterPerTestQueue.exchangeName,
    ttl: 2000,
  });

  const failedOrderDeletedMessageQueueClient = await testHelpers.startMQSubscriber(
    'real',
    // Not providing the queue name by default so it won't consume messages which make the ttl pass
    undefined,
    deadLetterPerTestQueue.queueName
  );

  // Act
  await deleteOrderPerTestQueue.mqClient.publish(
    deleteOrderPerTestQueue.exchangeName,
    'user.deleted',
    { id: 1 } // hard coded ID for the test
  );

  // Assert - the message arrived to the DLQ
  await failedOrderDeletedMessageQueueClient.waitFor(
    `ack:${deadLetterPerTestQueue.queueName}`,
    1
  );
});

test('When a message in `user-deleted` queue not being consumed after 2 seconds it should move to the dead letter exchange', async () => {
  // Arrange
  // The 'user-deleted' queue have TTL of 2 seconds

  const failedOrderDeletedMessageQueueClient = await testHelpers.startMQSubscriber(
    'real',
    // Not providing the queue name by default so it won't consume messages which make the ttl pass
    undefined,
    'failed-user-deleted'
  );

  // Act
  await deleteOrderPerTestQueue.mqClient.publish(
    deleteOrderPerTestQueue.exchangeName,
    'user.deleted',
    { id: 1 } // hard coded ID for the test
  );

  // Assert - the message arrived to the DLQ
  await failedOrderDeletedMessageQueueClient.waitFor(
    `ack:failed-user-deleted`,
    1
  );
});
