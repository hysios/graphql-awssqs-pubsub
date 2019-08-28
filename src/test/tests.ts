import AWS from "aws-sdk"
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { spy, mock } from 'simple-mock';
import { isAsyncIterable } from 'iterall';
import { SQSPubSub } from '../sqs-pubsub';
import SQSChannel from '../channel';
import { remove } from "lodash"
import { EventEmitter } from "events";

chai.use(chaiAsPromised);
const expect = chai.expect;

// -------------- Mocking AWS SQS PubSub Client ------------------

function getMockedSQSPubSub({ topic2SubName = undefined, commonMessageHandler = undefined } = {}) {
  let listener;
  let messages = []
  let id = 0

  // listener.on('message', (msg) => {
  //   messages.push(msg)
  // })

  let mockSQSChannel = new SQSChannel('test', { client: new AWS.SQS, commonMessageHandler })

  const buildMessage = (topic, msg) => {

    return {
      MessageAttributes: {
        Topic: {
          ValueType: "String",
          StringValue: topic
        },
      },
      ReceiptHandle: String(id++),
      Body: JSON.stringify(msg)
    }
  }

  const ensureMock = spy(() => Promise.resolve(mockSQSChannel))

  const publishMock = spy((topic, payload) => {
    messages.push(buildMessage(topic, payload))
    return Promise.resolve()
  })

  const receviceMessageMock = spy(() => {

    return new Promise((resolve) => {
      if (messages && !!messages.length) {
        resolve([messages[0]])
        return
      }

      setTimeout(() => {
        resolve([])
      }, 50)
    })
  })

  const deleteMessageMock = spy((handle) => {
    // console.log('delete', handle, messages)
    remove(messages, ({ ReceiptHandle }) => ReceiptHandle == handle)
    return Promise.resolve({})
  })

  const closeMock = spy(() => {
    mockSQSChannel.close()
    messages = []
  })

  mock(mockSQSChannel, 'ensure', ensureMock);
  mock(mockSQSChannel, 'publish', publishMock);
  mock(mockSQSChannel, 'receiveMessage', receviceMessageMock);
  mock(mockSQSChannel, 'deleteMessage', deleteMessageMock);

  const pubSub = new SQSPubSub({ channel: mockSQSChannel })
  // mock(pubSub, 'close', closeMock);

  return { pubSub };
}

// wait for the promise of the message handler
const asyncMessageHandler = () => new Promise(resolve => setTimeout(resolve, 100));
// wait for the promise of the subscribe --> wait for the listener
const asyncSubscribe = asyncMessageHandler;

// -------------- Mocking AWS SQS PubSub Client ------------------

describe('AWS SQSPubSub', () => {

  it('can subscribe to specific topic and called when a message is published on it', done => {
    const { pubSub } = getMockedSQSPubSub();
    pubSub
      .subscribe('Posts', message => {
        try {
          expect(message.toString()).to.equals('test');
          done();
        } catch (e) {
          done(e);
        }
      })
      .then(async subId => {
        expect(subId).to.be.a('number');
        pubSub.publish('Posts', 'test');
        await asyncMessageHandler();
        pubSub.unsubscribe(subId);
        pubSub.close()
      });
  });

  it('cleans up correctly the memory when unsubscribing', done => {
    const { pubSub } = getMockedSQSPubSub();
    Promise.all([pubSub.subscribe('Posts', () => null), pubSub.subscribe('Posts', () => null)]).then(
      ([subId, secondSubId]) => {
        try {
          // This assertion is done against a private member, if you change the internals, you may want to change that
          expect((pubSub as any).channel.subscriptionMap[subId]).not.to.be.an('undefined');
          pubSub.unsubscribe(subId);
          // This assertion is done against a private member, if you change the internals, you may want to change that
          expect((pubSub as any).channel.subscriptionMap[subId]).to.be.an('undefined');
          expect(() => pubSub.unsubscribe(subId)).to.throw(`There is no subscription of id "${subId}"`);
          pubSub.unsubscribe(secondSubId);
          done();
        } catch (e) {
          done(e);
        }
        pubSub.close()
      }
    );
  });

  it('can publish objects as well', done => {
    const { pubSub } = getMockedSQSPubSub();
    pubSub
      .subscribe('Posts', message => {
        try {
          expect(message).to.have.property('comment', 'This is amazing');
          done();
        } catch (e) {
          done(e);
        }
      })
      .then(async subId => {
        try {
          pubSub.publish('Posts', { comment: 'This is amazing' });
          await asyncMessageHandler();
          pubSub.unsubscribe(subId);
        } catch (e) {
          done(e);
        }
        pubSub.close()
      });
  });

  it('can use custom message handler', done => {
    const dateReviver = (key, value) => {
      const isISO8601Z = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)Z$/;
      if (typeof value === 'string' && isISO8601Z.test(value)) {
        const tempDateNumber = Date.parse(value);
        if (!isNaN(tempDateNumber)) {
          return new Date(tempDateNumber);
        }
      }
      return value;
    };

    function commonMessageHandler(message) {
      let parsedMessage;
      try {
        parsedMessage = JSON.parse(JSON.stringify(message), dateReviver);
      } catch (e) {
        parsedMessage = message;
      }
      return parsedMessage;
    }

    const { pubSub } = getMockedSQSPubSub({ commonMessageHandler });
    const validTime = new Date();
    const invalidTime = '2018-13-01T12:00:00Z';
    pubSub
      .subscribe('Times', message => {
        try {
          expect(message).to.have.property('invalidTime', invalidTime);
          expect(message).to.have.property('validTime');
          expect(message.validTime.getTime()).to.equals(validTime.getTime());
          pubSub.close()
          done();
        } catch (e) {
          done(e);
        }
      })
      .then(subId => {
        try {
          pubSub.publish('Times', { validTime, invalidTime });
          asyncMessageHandler().then(() => pubSub.unsubscribe(subId));
        } catch (e) {
          done(e);
        }
      });
  });

  it('throws if you try to unsubscribe with an unknown id', () => {
    const { pubSub } = getMockedSQSPubSub();
    pubSub.close()
    return expect(() => pubSub.unsubscribe(123)).to.throw('There is no subscription of id "123"');
  });

  it('can use a transform function to convert the topic name given into more explicit subscription name', done => {
    const topic2SubName = (topicName, { subscriptionSufix }) => `${topicName}-${subscriptionSufix}`;
    const { pubSub } = getMockedSQSPubSub({ topic2SubName });

    const validateMessage = message => {
      try {
        expect(message.toString()).to.equals('test');
        done();
      } catch (e) {
        done(e);
      }
    };

    pubSub
      .subscribe('comments', validateMessage)
      .then(async subId => {
        pubSub.publish('comments', 'test');
        await asyncMessageHandler();
        pubSub.unsubscribe(subId);
        pubSub.close()
      });
  });
});

describe('PubSubAsyncIterator', () => {
  it('should expose valid asyncIterator for a specific event', (done) => {
    const { pubSub } = getMockedSQSPubSub();
    const eventName = 'test';
    const iterator = pubSub.asyncIterator(eventName);
    // tslint:disable-next-line:no-unused-expression
    expect(iterator).to.exist;
    // tslint:disable-next-line:no-unused-expression
    expect(isAsyncIterable(iterator)).to.be.true;

    asyncMessageHandler().then(() => pubSub.close())
    done()
  });

  it('should trigger event on asyncIterator when published', done => {
    const { pubSub } = getMockedSQSPubSub();
    const eventName = 'test';
    const iterator = pubSub.asyncIterator(eventName);

    iterator.next().then(result => {
      // tslint:disable-next-line:no-unused-expression
      expect(result).to.exist;
      // tslint:disable-next-line:no-unused-expression
      expect(result.value).to.exist;
      // tslint:disable-next-line:no-unused-expression
      expect(result.done).to.exist;

      done();
      pubSub.close()
    });
    // Todo: check if the needed timeout here could be an issue
    // Todo: related? https://github.com/davidyaha/graphql-redis-subscriptions/issues/90
    // the subscriber needs some time to subscribe

    asyncSubscribe().then(() => pubSub.publish(eventName, { test: true }));
  });

  it('should not trigger event on asyncIterator when publishing other event', (done) => {
    const { pubSub } = getMockedSQSPubSub();
    const eventName = 'test2';
    const iterator = pubSub.asyncIterator('test');
    const triggerSpy = spy(() => undefined);

    iterator.next().then(triggerSpy);
    pubSub.publish(eventName, { test: true });
    expect(triggerSpy.callCount).to.equal(0);
    asyncMessageHandler().then(() => pubSub.close())
    done()
  });

  it('register to multiple events', done => {
    const { pubSub } = getMockedSQSPubSub();
    const eventName = 'test2';
    const iterator = pubSub.asyncIterator(['test', 'test2']);
    const triggerSpy = spy(() => undefined);

    iterator.next().then(() => {
      triggerSpy();
      expect(triggerSpy.callCount).to.be.gte(1);
      pubSub.close()
      done();
    });
    // Todo: check if the needed timeout here could be an issue
    // Todo: related? https://github.com/davidyaha/graphql-redis-subscriptions/issues/90
    // the subscriber needs some time to subscribe
    asyncSubscribe().then(() => pubSub.publish(eventName, { test: true }));
  });

  it('should not trigger event on asyncIterator already returned', done => {
    const { pubSub } = getMockedSQSPubSub();
    const eventName = 'test';
    const iterator = pubSub.asyncIterator<{ data: Buffer }>(eventName);

    iterator
      .next()
      .then(result => {
        // tslint:disable-next-line:no-unused-expression
        expect(result).to.exist;
        // tslint:disable-next-line:no-unused-expression
        expect(result.value).to.exist;
        expect((result.value as any).test).to.equal('word');
        // tslint:disable-next-line:no-unused-expression
        expect(result.done).to.be.false;
      })
      .then(() =>
        iterator.next().then(result => {
          // tslint:disable-next-line:no-unused-expression
          expect(result).to.exist;
          // tslint:disable-next-line:no-unused-expression
          expect(result.value).not.to.exist;
          // tslint:disable-next-line:no-unused-expression
          expect(result.done).to.be.true;
          pubSub.close()
          done();
        })
      );

    asyncSubscribe()
      .then(() => pubSub.publish(eventName, { test: 'word' }))
      .then(asyncMessageHandler)
      .then(() => iterator.return())
      .then(() => pubSub.publish(eventName, { test: true }));
  });
});
