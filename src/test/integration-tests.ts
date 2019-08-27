import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import {
    mock
} from 'simple-mock';
import {
    parse,
    GraphQLSchema,
    GraphQLObjectType,
    GraphQLString
} from 'graphql';
import {
    isAsyncIterable
} from 'iterall';
import {
    subscribe
} from 'graphql/subscription';

import {
    SQSPubSub
} from '../sqs-pubsub';
import {
    withFilter
} from 'graphql-subscriptions';

chai.use(chaiAsPromised);
const expect = chai.expect;

const FIRST_EVENT = 'FIRST_EVENT';
const SECOND_EVENT = 'SECOND_EVENT';

function buildSchema(iterator, patternIterator) {
    return new GraphQLSchema({
        query: new GraphQLObjectType({
            name: 'Query',
            fields: {
                testString: {
                    type: GraphQLString,
                    resolve: function (_, args) {
                        return 'works';
                    },
                },
            },
        }),
        subscription: new GraphQLObjectType({
            name: 'Subscription',
            fields: {
                testSubscription: {
                    type: GraphQLString,
                    subscribe: withFilter(() => iterator, () => true),
                    resolve: root => {
                        return 'FIRST_EVENT';
                    },
                },

                testPatternSubscription: {
                    type: GraphQLString,
                    subscribe: withFilter(() => patternIterator, () => true),
                    resolve: root => {
                        return 'SECOND_EVENT';
                    },
                },
            },
        }),
    });
}

describe('PubSubAsyncIterator', function () {
    const query = parse(`
    subscription S1 {
      testSubscription
    }
  `);

    const patternQuery = parse(`
    subscription S1 {
      testPatternSubscription
    }
  `);

    const pubsub = new SQSPubSub({ channelName: 'test', region: 'cn-north-1' });
    const origIterator = pubsub.asyncIterator(FIRST_EVENT);
    const origPatternIterator = pubsub.asyncIterator('SECOND*', {
        pattern: true
    });
    const returnSpy = mock(origIterator, 'return');
    const schema = buildSchema(origIterator, origPatternIterator);

    before(() => {
        // Warm the redis connection so that tests would pass
        pubsub.publish('WARM_UP', {});
    });

    after(() => {
        pubsub.close();
    });

    it('should allow subscriptions', () =>
        subscribe(schema, query)
            .then(ai => {
                // tslint:disable-next-line:no-unused-expression
                expect(isAsyncIterable(ai)).to.be.true;

                const r = (ai as any).next();
                pubsub.publish(FIRST_EVENT, {})
                return r;
            })
            .then(res => {
                expect(res.value.data.testSubscription).to.equal('FIRST_EVENT');
            }));

    it('should allow pattern subscriptions', () =>
        subscribe(schema, patternQuery)
            .then(ai => {
                // tslint:disable-next-line:no-unused-expression
                expect(isAsyncIterable(ai)).to.be.true;

                const r = (ai as any).next();
                pubsub.publish(SECOND_EVENT, {});

                return r;
            })
            .then(res => {
                expect(res.value.data.testPatternSubscription).to.equal('SECOND_EVENT');
            }));

    it('should clear event handlers', () =>
        subscribe(schema, query)
            .then(ai => {
                // tslint:disable-next-line:no-unused-expression
                expect(isAsyncIterable(ai)).to.be.true;

                pubsub.publish(FIRST_EVENT, {});

                return (ai as any).return();
            })
            .then(res => {
                expect(returnSpy.callCount).to.be.gte(1);
            }));
});