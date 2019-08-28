# graphql-awssqs-pubsub

This package implements the PubSubEngine Interface from the [graphql-subscriptions](https://github.com/apollographql/graphql-subscriptions) package and also the new AsyncIterator interface. 
It allows you to connect your subscriptions manger to a AWS SQS mechanism to support 
multiple subscription manager instances.

## Installation

`npm install graphql-awssqs-pubsub` 
or
`yarn add graphql-awssqs-pubsub`
   
## Using as AsyncIterator

Define your GraphQL schema with a `Subscription` type:

```graphql
schema {
  query: Query
  mutation: Mutation
  subscription: Subscription
}

type Subscription {
    somethingChanged: Result
}

type Result {
    id: String
}
```

Now, let's create a simple `SQSSubPub` instance:

```javascript
import { SQSSubPub } from 'graphql-awssqs-pubsub';
const pubsub = new SQSSubPub();
```

Now, implement your Subscriptions type resolver, using the `pubsub.asyncIterator` to map the event you need:

```javascript
const SOMETHING_CHANGED_TOPIC = 'something_changed';

export const resolvers = {
  Subscription: {
    somethingChanged: {
      subscribe: () => pubsub.asyncIterator(SOMETHING_CHANGED_TOPIC),
    },
  },
}
```

> Subscriptions resolvers are not a function, but an object with `subscribe` method, that returns `AsyncIterable`.

Calling the method `asyncIterator` of the `SQSPubSub` instance will subscribe to the topic provided and will return an `AsyncIterator` binded to the SQSPubSub instance and listens to any event published on that topic.
Now, the GraphQL engine knows that `somethingChanged` is a subscription, and every time we will use `pubsub.publish` over this topic, the `SQSPubSub` will `PUBLISH` the event to all other subscribed instances and those in their turn will emit the event to GraphQL using the `next` callback given by the GraphQL engine.

```js
pubsub.publish(SOMETHING_CHANGED_TOPIC, { somethingChanged: { id: "123" }});
```

The topic doesn't get created automatically, it has to be created beforehand.

If you publish non string data it gets stringified and you have to [parse the received message data](#receive-messages).

## Receive Messages


You might extract the data (Buffer) in there or use a [common message handler](#commonmessagehandler) to transform the received message.

```javascript
function commonMessageHandler ({attributes = {}, data = ''}) {
  return {
    ...attributes,
    text: data.toString()
  };
}
```

The `can use custom message handler` test illustrates the flexibility of the common message handler.

## Dynamically use a topic based on subscription args passed on the query:

```javascript
export const resolvers = {
  Subscription: {
    somethingChanged: {
      subscribe: (_, args) => pubsub.asyncIterator(`${SOMETHING_CHANGED_TOPIC}.${args.relevantId}`),
    },
  },
}
```

## Using both arguments and payload to filter events

```javascript
import { withFilter } from 'graphql-subscriptions';

export const resolvers = {
  Subscription: {
    somethingChanged: {
      subscribe: withFilter(
        (_, args) => pubsub.asyncIterator(`${SOMETHING_CHANGED_TOPIC}.${args.relevantId}`),
        (payload, variables) => payload.somethingChanged.id === variables.relevantId,
      ),
    },
  },
}
```

## Creating the AWSSQS PubSub Client

```javascript
import { SQSPubSub } from '@axelspringer/graphql-awssqs-pubsub';

const pubSub = new SQSPubSub(options, { commonMessageHandler })
```

### Options
This are the [options](https://cloud.google.com/nodejs/docs/reference/pubsub/0.23.x/global#ClientConfig) which are passed to the internal Google PubSub client.
The client will extract credentials, project name etc. from environment variables if provided.
Have a look at the [authentication guide](https://cloud.google.com/docs/authentication/getting-started) for more information.
Otherwise you can provide this details in the options.
```javascript
const options = {
  projectId: 'project-abc',
  credentials:{
    client_email: 'client@example-email.iam.gserviceaccount.com',
    private_key: '-BEGIN PRIVATE KEY-\nsample\n-END PRIVATE KEY-\n'
  }
};
```

### commonMessageHandler

The common message handler gets called with the received message from AWS SQS PubSub.
You can transform the message before it is passed to the individual filter/resolver methods of the subscribers.
This way it is for example possible to inject one instance of a [DataLoader](https://github.com/facebook/dataloader) which can be used in all filter/resolver methods.

```javascript
const getDataLoader = () => new DataLoader(...);
const commonMessageHandler = ({attributes: {id}, data}) => ({id, dataLoader: getDataLoader()});
```

```javascript
export const resolvers = {
  Subscription: {
    somethingChanged: {
      resolve: ({id, dataLoader}) => dataLoader.load(id)
    },
  },
}
```

## Author

[Yi Hu](https://github.com/hysios)

## Acknowledgements

This project is mostly inspired by [graphql-redis-subscriptions](https://github.com/davidyaha/graphql-redis-subscriptions).
